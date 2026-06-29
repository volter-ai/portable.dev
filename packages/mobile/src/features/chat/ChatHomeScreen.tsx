/**
 * ChatHomeScreen — the new-chat landing, a 1:1 visual port of the web `HomePage`.
 *
 * Layout (web default config, top → bottom): a header row holding the
 * project-selection trigger ("Auto detect" …) on the left and the glassmorphic
 * profile pill on the right (passed into {@link ChatComposer} as `headerRight` so
 * the two share one baseline — no dead space above the composer), the new-chat
 * input card ({@link ChatComposer}, with the project-selection dropdown + framework
 * pills + model/permissions/agent controls), the swipeable recent-repos
 * grid, and the "Continue chats" preview. There is intentionally NO greeting header
 * — the web default renders none.
 *
 * The profile identity comes from the non-secret `authStore` (initial) + the
 * `GET /api/user` avatar — NOT `@clerk/clerk-expo`, deliberately: ChatHomeScreen is
 * re-exported from the chat barrel, and pulling clerk-expo into that graph would
 * force a clerk mock into every chat-barrel test (the real module hangs Jest).
 */

import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KeyboardAvoidingView } from './KeyboardAvoidingViewCompat';

import { useChatActionSheet } from './ChatActionSheet';
import { ChatComposer } from './ChatComposer';
import { CHAT_LIST_POLL_INTERVAL_MS } from './chatListPolling';
import { DEFAULT_FRAMEWORK, sanitizeFolderName } from './newChatFlow';
import { HOME_DRAFT_KEY } from './useChatComposer';
import { useChats, useCreateProject, useRepos, useUser } from '../api/hooks';
// Direct FILE import (not the pc-connect barrel) keeps the chat-barrel Jest graph
// lean — this screen is re-exported from the chat barrel. The repos-error remedy is
// "Connect PC" (re-scan the pairing QR): when the repos fetch fails the cause is the
// PC connection (the relay/JWT). In local-first GitHub credentials live on the PC, so
// there is no phone-side GitHub connect.
import { PcConnectModal, type PcConnectModalProps } from '../pc-connect/PcConnectModal';
import {
  HomeChatsSection,
  HomeErrorDisplay,
  HomeReposGrid,
  NewProjectModal,
  ProfilePill,
} from '../home';
import { useBlockedOrgsParam } from '../settings/sections/organizations/blockedOrgsStore';
import { useAppTheme } from '../../theme';

/** The home input persists its draft under a reserved chat-store key. */
export { HOME_DRAFT_KEY };

/**
 * Recent-repos fetch params (the home "Linked Projects" grid). Lists the full account
 * list (cloned + recent remotes) so the preview can fill up to ~12 — cloned repos float
 * to the top (backend score sort). Tapping an uncloned tile opens its Overview (clone
 * there). (No `localOnly` — that workspace-only listing capped the preview at the local
 * repo count; the Repos tab made the same change to surface uncloned remotes.)
 */
const REPOS_PARAMS = {
  page: 1,
  per_page: 12,
  sort: 'updated',
  skipGitOperations: 'true',
} as const;

/**
 * "Continue chats" preview: show up to this many recent chats inside a SELF-CONTAINED,
 * internally-scrolling area (it does NOT move the home page) with edge fades — the rest
 * live behind "See more" (→ the Chats tab). Data is already loaded by `useChats()`.
 */
const RECENT_CHATS_MAX = 12;

export interface ChatHomeScreenProps {
  /** Override the PC-connect (QR re-scan) seams of the repos-error modal (tests). */
  pcConnect?: Pick<PcConnectModalProps, 'link' | 'connect' | 'renderScanner'>;
}

export function ChatHomeScreen({ pcConnect }: ChatHomeScreenProps = {}) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { theme } = useAppTheme();
  // Poll the chat list while the Home tab is focused (chats are created/updated on the
  // PC AND the phone) and never serve a stale cache (`staleTime: 0`). Polling pauses
  // while another tab is focused or the app is backgrounded (the `homeFocused` gate +
  // `refetchIntervalInBackground: false`) to spare battery and the relay.
  const [homeFocused, setHomeFocused] = useState(true);
  const chatsQuery = useChats({
    staleTime: 0,
    refetchInterval: homeFocused ? CHAT_LIST_POLL_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });
  // Long-press a chat in the "Continue chats" preview → the shared Pin/Save/Archive/
  // Delete sheet (the same menu as the /chats directory).
  const chatActions = useChatActionSheet();
  // Hide repos owned by orgs the user blocked in Settings → Organizations (the
  // filter is applied server-side; an empty blocklist omits the param so the
  // query key / URL are unchanged). Reactive — toggling an org refetches.
  const blockedOrgs = useBlockedOrgsParam();
  const reposParams = useMemo(
    () => (blockedOrgs ? { ...REPOS_PARAMS, blockedOrgs } : REPOS_PARAMS),
    [blockedOrgs]
  );
  const reposQuery = useRepos(reposParams);
  const userQuery = useUser({ retry: false });
  // "Connect PC" on the repos-error card re-opens the QR scanner: a failed repos
  // fetch means the PC connection is broken (the gateway TunnelRegistry lapsed or
  // the token is rejected), so re-pairing — not GitHub — is the remedy.
  const [connectPcOpen, setConnectPcOpen] = useState(false);
  // The "＋ New" tile (front of the Linked-Projects grid) opens a name form, then
  // bootstraps a folder + GitHub repo via POST /api/projects/create (D-default
  // framework, like the composer's new-repo intent) and opens the new repo.
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const createProject = useCreateProject();
  // Tapping a home repo opens its Overview page (the repo dashboard owns the
  // "start working" input; same target as the Repos tab).
  const openRepo = useCallback(
    (owner: string, repo: string) => router.push(`/repos/${owner}/${repo}`),
    [router]
  );

  const submitNewProject = useCallback(
    (name: string, options: { createGithubRepo: boolean }) => {
      const folderName = sanitizeFolderName(name);
      createProject.mutate(
        {
          folderName,
          // Framework scaffold only applies to the GitHub path; local-only is a bare git repo.
          framework: options.createGithubRepo ? DEFAULT_FRAMEWORK : undefined,
          github: options.createGithubRepo,
        },
        {
          onSuccess: (res) => {
            setNewProjectOpen(false);
            createProject.reset();
            if (res.owner && res.repoName) router.push(`/repos/${res.owner}/${res.repoName}`);
          },
        }
      );
    },
    [createProject, router]
  );

  const avatarUrl = userQuery.data?.user?.avatar_url ?? null;

  const repos = reposQuery.data?.repos ?? [];
  const reposError = reposQuery.isError && repos.length === 0;

  const recentChats = [...(chatsQuery.data?.chats ?? [])]
    .filter((c) => !c.archived)
    .sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0))
    .slice(0, RECENT_CHATS_MAX);

  // Stable refs so the focus effect + pull-to-refresh reach the latest query objects
  // without re-subscribing every render (the queries get a new identity each render).
  const reposQueryRef = useRef(reposQuery);
  reposQueryRef.current = reposQuery;
  const chatsQueryRef = useRef(chatsQuery);
  chatsQueryRef.current = chatsQuery;

  // Re-focusing the Home tab refreshes the chats immediately — the poll interval only
  // resumes ticking on focus, so without this you'd wait up to CHAT_LIST_POLL_INTERVAL_MS.
  // The first focus is the initial mount, which already fetches — skip it.
  const firstFocusRef = useRef(true);
  useFocusEffect(
    useCallback(() => {
      setHomeFocused(true);
      if (firstFocusRef.current) {
        firstFocusRef.current = false;
      } else {
        void chatsQueryRef.current.refetch();
      }
      return () => setHomeFocused(false);
    }, [])
  );

  // Pull-to-refresh keeps its OWN spinner state — NOT `chatsQuery.isRefetching`, which
  // would engage the native pull spinner on every background poll (the Tasks-screen
  // gotcha). It refetches repos + chats and clears once both settle.
  const [pulling, setPulling] = useState(false);
  const onRefresh = useCallback(() => {
    setPulling(true);
    void Promise.all([reposQueryRef.current.refetch(), chatsQueryRef.current.refetch()]).finally(
      () => setPulling(false)
    );
  }, []);

  const refreshing = pulling;

  return (
    <KeyboardAvoidingView
      style={[styles.fill, { backgroundColor: theme.colors.background }]}
      behavior="padding"
      testID="chat-home"
    >
      {/* The home page is ANCHORED — it never scrolls as a whole, so the profile pill,
          composer, and repos grid stay pinned to the top. Only the "Continue chats"
          area below scrolls (internally, filling the remaining space). This fixes the
          old whole-page scroll that engaged once content overflowed (and that you'd hit
          by scrolling the interior chats list past its bottom). */}
      <View
        style={[
          styles.container,
          // NO bottom inset/padding: this is a tab screen and the bottom-tabs
          // navigator already absorbs the safe-area inset, so the chats area below
          // extends flush to the tab bar (no dead space). Top keeps its inset.
          { paddingTop: insets.top + 16 },
        ]}
      >
        <View style={styles.content}>
          <ChatComposer
            headerRight={
              <ProfilePill avatarUrl={avatarUrl} onPress={() => router.push('/settings')} />
            }
          />

          {reposError ? (
            <HomeErrorDisplay
              error={{ code: 'NETWORK_ERROR', message: reposQuery.error?.message }}
              context="fetch repositories"
              action={{
                label: 'Connect PC',
                testID: 'home-connect-pc',
                onPress: () => setConnectPcOpen(true),
              }}
            />
          ) : (
            <HomeReposGrid
              repos={repos}
              loading={reposQuery.isLoading}
              onRepoPress={openRepo}
              onSeeMore={() => router.push('/repos')}
              onNewProject={() => setNewProjectOpen(true)}
            />
          )}

          {/* Fills the remaining space + owns pull-to-refresh (the only scrollable
              region on the anchored home). */}
          <HomeChatsSection
            chats={recentChats}
            loading={chatsQuery.isLoading}
            onChatPress={(chatId) => router.push(`/chat/${chatId}`)}
            onChatLongPress={chatActions.open}
            onSeeMore={() => router.push('/chats')}
            fill
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={theme.colors.primary}
              />
            }
          />
        </View>
      </View>

      <PcConnectModal
        visible={connectPcOpen}
        link={pcConnect?.link}
        connect={pcConnect?.connect}
        renderScanner={pcConnect?.renderScanner}
        onConnected={() => {
          // Re-pointed at the PC — refetch the repos that failed on the dead link.
          void reposQuery.refetch();
        }}
        onDismiss={() => setConnectPcOpen(false)}
      />

      <NewProjectModal
        visible={newProjectOpen}
        submitting={createProject.isPending}
        error={createProject.isError ? (createProject.error?.message ?? 'Failed to create') : null}
        onSubmit={submitNewProject}
        onCancel={() => {
          setNewProjectOpen(false);
          createProject.reset();
        }}
      />

      {chatActions.element}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  container: { flex: 1, paddingHorizontal: 24 },
  // flex:1 so the chats section (fill) expands to fill the space below the fixed
  // top content instead of pushing the page into a whole-page scroll. A small top
  // margin (the safe-area inset already pads above) keeps the header row — the
  // project selector + profile pill — a clean distance below the status bar.
  content: { flex: 1, gap: 32, marginTop: 8 },
});
