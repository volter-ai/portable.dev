import { SettingsScreen } from '@/features/settings/SettingsScreen';

// Settings tab (`/settings`) — the settings/profile navigation hub (US-E6-001a).
// Thin shell. Section screens (e.g. `/settings/plan`, `/settings/theme`) are
// stack routes under `app/settings/` (added in US-E6-001b/001c).
export default function SettingsTab() {
  return <SettingsScreen />;
}
