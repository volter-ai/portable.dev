export type PermissionMode = 'default' | 'plan' | 'accept_edits' | 'bypass_permissions';

export interface PermissionConfig {
  value: PermissionMode;
  label: string;
  description: string;
  color: string;
  hoverColor: string;
}

export const PERMISSIONS: Record<PermissionMode, PermissionConfig> = {
  default: {
    value: 'default',
    label: 'Always Ask',
    description: 'Ask before every action (read and write)',
    color: '#6b7280',
    hoverColor: '#9ca3af',
  },
  plan: {
    value: 'plan',
    label: 'Plan',
    description: 'Create plan before executing',
    color: '#3b82f6',
    hoverColor: '#60a5fa',
  },
  accept_edits: {
    value: 'accept_edits',
    label: 'Ask for Edit',
    description: 'Ask before making changes (auto-approve reads)',
    color: '#22c55e',
    hoverColor: '#4ade80',
  },
  bypass_permissions: {
    value: 'bypass_permissions',
    label: 'Bypass',
    description: 'Execute everything without asking',
    color: '#f59e0b',
    hoverColor: '#fbbf24',
  },
} as const;

export const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'plan',
  'accept_edits',
  'bypass_permissions',
] as const;

export function getPermissionConfig(mode: PermissionMode): PermissionConfig {
  return PERMISSIONS[mode];
}

export function getNextPermission(current: PermissionMode): PermissionMode {
  const currentIndex = PERMISSION_MODES.indexOf(current);
  const nextIndex = (currentIndex + 1) % PERMISSION_MODES.length;
  return PERMISSION_MODES[nextIndex];
}
