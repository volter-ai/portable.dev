/**
 * useRepoPage — the RepoPage shell ViewModel.
 *
 * Owns the active-tab state, applying the allowed-tabs guard (`resolveRepoTab`)
 * to the incoming `?tab=` param so an unknown value falls back to the wired
 * default. Tab switches are local state.
 */

import { useCallback, useState } from 'react';

import { resolveRepoTab, type RepoTab } from './repoTabs';

export interface UseRepoPageOptions {
  /** Initial `?tab=` param (honored only if it is a wired tab name). */
  initialTab?: string | null;
}

export interface UseRepoPage {
  activeTab: RepoTab;
  setTab: (tab: RepoTab) => void;
}

export function useRepoPage(options: UseRepoPageOptions = {}): UseRepoPage {
  const [activeTab, setActiveTab] = useState<RepoTab>(() => resolveRepoTab(options.initialTab));
  const setTab = useCallback((tab: RepoTab) => setActiveTab(tab), []);
  return { activeTab, setTab };
}
