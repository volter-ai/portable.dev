import { Stack } from 'expo-router';

// Runtime detail/list stack (`/runtime/<...>`) — sibling of the `(tabs)/runtime.tsx`
// overview hub (the same file+dir trick as `repos.tsx` + `repos/`). These screens
// push OVER the tab bar; each owns its themed header (RuntimeHeader), so the
// navigator chrome stays hidden.
export default function RuntimeStackLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
