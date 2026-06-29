import { ChatHomeScreen } from '@/features/chat';

// Home tab (`/`) — the chat composer / new-message entry (US-E4-004). Thin shell
// delegating to the feature screen, per the project layout convention.
export default function HomeTab() {
  return <ChatHomeScreen />;
}
