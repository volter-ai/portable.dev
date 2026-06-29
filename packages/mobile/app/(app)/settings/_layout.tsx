import { Stack } from 'expo-router';

// Settings section stack (`/settings/<key>`, US-E6-001b/001c) — sibling of the
// `(tabs)/settings.tsx` root menu (the same file+dir trick as `repos`). Each
// section screen owns its themed header, so the navigator chrome stays hidden.
export default function SettingsSectionsLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
