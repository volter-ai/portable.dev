import { Tabs } from 'expo-router';
import { StyleSheet, type ColorValue } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, WhaleIcon, useAppTheme, type IconName } from '@/theme';

/**
 * Authenticated bottom-tab navigator (US-009) — the tab bar order is:
 *
 *   Home (`/`)        → the chat composer / new-message entry (`ChatHomeScreen`)
 *   Chat (`/chats`)   → the paginated chat directory (`ChatDirectoryScreen`)
 *   Repo (`/repos`)   → the searchable repository list (`RepoListScreen`)
 *   Tasks (`/tasks`)  → the grouped GitHub issues/PRs dashboard (`TasksScreen`)
 *   Runtime (`/runtime`) → the sandbox runtime monitor (`RuntimeBox`)
 *
 * Settings is NOT a tab (web parity — the web BottomNav has no Settings entry):
 * its Screen entry uses `href: null`, which removes the tab BUTTON but keeps
 * `/settings` registered and routable — the Home profile pill
 * (`router.push('/settings')`) is the navigation path to it.
 *
 * Stack DETAIL routes (`/repos/[owner]/[repo]`, the file viewer, the runtime
 * stack) live OUTSIDE this group, so opening one pushes over the tab bar — they
 * stay thin shells, no feature logic moves into `app/`. The ACTIVE CHAT
 * (`/chat/[chatId]`) is the exception (#1372): it lives INSIDE the group as a
 * hidden screen (`href: null`, like Settings) so the tab bar stays visible
 * while a chat is open; `backBehavior="history"` makes the chat header's back
 * chevron (`router.back()`) return to whichever tab the chat was opened from
 * (the default `firstRoute` would always land on Home).
 *
 * Visual parity with the web `BottomNav`: an ~80px bar on `backgroundElevated`
 * with a 1px top border, active tint = `text` / inactive = `textTertiary`, 12px
 * labels, and SVG line-icons + the whale brand mark (FontAwesome/vector-icons are
 * not bundled). When `boldMode` is on, the bar fills with the accent gradient and
 * the tints flip to the readable bold-text color — the web BottomNav's
 * `getBoldBackground` behavior. The dark sign-in/onboarding `signInTheme.ts` is no
 * longer used here (the authenticated app follows the live `useAppTheme`).
 */

/** A themed tab icon: the whale brand mark for Home, line-icons for the rest. */
function TabIcon({ icon, color }: { icon: IconName | 'whale'; color: ColorValue }) {
  const tint = color as string;
  if (icon === 'whale') return <WhaleIcon size={26} color={tint} />;
  return <Icon name={icon} size={24} color={tint} />;
}

export default function TabsLayout() {
  const { theme, boldMode, boldGradient, getBoldTextColor } = useAppTheme();
  const insets = useSafeAreaInsets();

  const boldFg = getBoldTextColor();
  const activeTint = boldMode ? boldFg : theme.colors.text;
  const inactiveTint = boldMode
    ? boldFg === '#FFFFFF'
      ? 'rgba(255,255,255,0.6)'
      : 'rgba(0,0,0,0.45)'
    : theme.colors.textTertiary;

  return (
    <Tabs
      backBehavior="history"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: activeTint,
        tabBarInactiveTintColor: inactiveTint,
        tabBarLabelStyle: { fontSize: 12, fontWeight: '500' },
        tabBarStyle: {
          backgroundColor: boldMode ? 'transparent' : theme.colors.backgroundElevated,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: boldMode ? theme.colors.primaryDark : theme.colors.border,
          height: 60 + insets.bottom,
          paddingTop: 8,
          paddingBottom: insets.bottom > 0 ? insets.bottom : 8,
        },
        tabBarBackground: boldMode
          ? () => (
              <LinearGradient
                colors={boldGradient}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={StyleSheet.absoluteFill}
              />
            )
          : undefined,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarButtonTestID: 'tab-button-home',
          tabBarIcon: ({ color }) => <TabIcon icon="whale" color={color} />,
        }}
      />
      <Tabs.Screen
        name="chats"
        options={{
          title: 'Chat',
          tabBarButtonTestID: 'tab-button-chats',
          tabBarIcon: ({ color }) => <TabIcon icon="comments" color={color} />,
        }}
      />
      <Tabs.Screen
        name="repos"
        options={{
          title: 'Repo',
          tabBarButtonTestID: 'tab-button-repos',
          tabBarIcon: ({ color }) => <TabIcon icon="code-branch" color={color} />,
        }}
      />
      <Tabs.Screen
        name="tasks"
        options={{
          title: 'Tasks',
          tabBarButtonTestID: 'tab-button-tasks',
          tabBarIcon: ({ color }) => <TabIcon icon="square-check" color={color} />,
        }}
      />
      <Tabs.Screen
        name="runtime"
        options={{
          title: 'Runtime',
          tabBarButtonTestID: 'tab-button-runtime',
          tabBarIcon: ({ color }) => <TabIcon icon="mobile-screen" color={color} />,
        }}
      />
      {/* Settings stays routable (Home profile pill → /settings) but has no tab
          button — web BottomNav parity (#1340). The testID is kept ALONGSIDE
          `href: null` so the tab-navigation test's "no settings button"
          assertion is falsifiable: if the hide ever regresses, the reappearing
          button carries the testID and the null-check fails. */}
      <Tabs.Screen
        name="settings"
        options={{ href: null, tabBarButtonTestID: 'tab-button-settings' }}
      />
      {/* The active chat is a hidden tab screen (#1372): no tab button, but the
          tab bar stays visible under the open conversation. */}
      <Tabs.Screen name="chat/[chatId]" options={{ href: null }} />
    </Tabs>
  );
}
