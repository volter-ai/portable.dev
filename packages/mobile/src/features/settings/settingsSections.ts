/**
 * Settings section catalog.
 *
 * The settings root (`SettingsScreen`) renders one navigation entry per section
 * (title, description, ORDER, and the search `keywords`). Preferences, Home Page
 * Settings, and Dev Mode are deliberately excluded. "Sentry Test" IS included but
 * is NOT a normal section: it lives at `/settings/sentry-test` and is surfaced
 * from the settings root ONLY while the hidden dev mode is on (see
 * `SettingsScreen`'s `settings-dev-sentry-test` entry), so it stays out of this
 * catalog. Section keys are stable route segments — they don't always match the
 * display label, so e.g. key `connections` renders "Connected Services" and key
 * `mcp` renders "MCP Servers".
 *
 * Each `route` is reachable via Expo Router (`/settings/<key>`); the section
 * CONTENT screens live in `src/features/settings/sections/<key>/` with thin
 * route shells under `app/(app)/settings/`.
 */

export interface SettingsSection {
  /** Stable key — also the route segment (`/settings/<key>`). */
  key: string;
  /** Row label shown in the settings root. */
  label: string;
  /** Short supporting copy under the label. */
  description: string;
  /** Expo Router path the entry navigates to. */
  route: string;
  /** Search-bar match terms. */
  keywords: string[];
}

/** Build the Expo Router path for a section key. */
export function sectionRoute(key: string): string {
  return `/settings/${key}`;
}

/**
 * Ordered settings sections.
 */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    key: 'organizations',
    label: 'GitHub Organizations',
    description: 'Block or unblock organizations from view',
    route: sectionRoute('organizations'),
    keywords: ['github', 'org', 'organizations', 'block', 'unblock'],
  },
  {
    key: 'connections',
    label: 'Connected Services',
    description: 'Manage connected third-party services',
    route: sectionRoute('connections'),
    keywords: ['services', 'third party', 'connections', 'integrations', 'oauth'],
  },
  {
    key: 'claude-account',
    label: 'Claude Account',
    description: 'Sign in with your Claude subscription',
    route: sectionRoute('claude-account'),
    keywords: [
      'claude',
      'anthropic',
      'login',
      'sign in',
      'token',
      'oauth',
      'credential',
      'api key',
      'expired',
      'ai',
    ],
  },
  {
    key: 'theme',
    label: 'Theme',
    description: 'Brightness, colors, gradients, backgrounds',
    route: sectionRoute('theme'),
    keywords: [
      'dark',
      'light',
      'colors',
      'brightness',
      'gradient',
      'background',
      'appearance',
      'purple',
      'blue',
      'green',
      'red',
      'orange',
    ],
  },
  {
    key: 'ai-style',
    label: 'AI Style',
    description: 'Customize AI assistant behavior and tone',
    route: sectionRoute('ai-style'),
    keywords: [
      'assistant',
      'behavior',
      'tone',
      'ai',
      'style',
      'personality',
      'custom instructions',
      'system prompt',
    ],
  },
  {
    key: 'commits',
    label: 'Commits',
    description: 'AI co-author attribution on commits',
    route: sectionRoute('commits'),
    keywords: [
      'commit',
      'commits',
      'co-author',
      'coauthor',
      'co author',
      'attribution',
      'git',
      'author',
      'claude',
      'ai',
    ],
  },
  {
    key: 'secrets',
    label: 'Secrets',
    description: 'Environment variables and API keys',
    route: sectionRoute('secrets'),
    keywords: [
      'env',
      'environment',
      'variables',
      'api',
      'keys',
      'secrets',
      'tokens',
      'credentials',
    ],
  },
  {
    key: 'agent-setups',
    label: 'Agent Setups',
    description: 'View orchestration types and sub-agents',
    route: sectionRoute('agent-setups'),
    keywords: [
      'agent',
      'orchestration',
      'sub agents',
      'setups',
      'delegation',
      'direct execution',
      'hybrid',
    ],
  },
  {
    key: 'mcp',
    label: 'MCP Servers',
    description: 'View all available MCP servers and status',
    route: sectionRoute('mcp'),
    keywords: [
      'mcp',
      'servers',
      'status',
      'model context protocol',
      'playwright',
      'github',
      'google drive',
    ],
  },
  {
    key: 'notifications',
    label: 'Notifications',
    description: 'Push notification settings and preferences',
    route: sectionRoute('notifications'),
    keywords: ['notifications', 'push', 'alerts', 'bell', 'subscribe', 'unsubscribe'],
  },
  {
    key: 'permissions',
    label: 'Permissions',
    description: 'Manage device permissions (mic, notifications, etc.)',
    route: sectionRoute('permissions'),
    keywords: [
      'permissions',
      'mic',
      'microphone',
      'notifications',
      'device',
      'access',
      'camera',
      'location',
    ],
  },
];

/**
 * Case-insensitive section search over label, description and keywords
 * (dynamic-content matches from already-fetched secrets/mcps/connections are
 * not included).
 */
export function filterSections(sections: SettingsSection[], query: string): SettingsSection[] {
  const q = query.trim().toLowerCase();
  if (!q) return sections;
  return sections.filter(
    (s) =>
      s.label.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.keywords.some((k) => k.toLowerCase().includes(q))
  );
}
