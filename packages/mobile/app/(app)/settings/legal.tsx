import { useLocalSearchParams } from 'expo-router';

import { LegalScreen, type LegalDoc } from '@/features/settings/legal/LegalScreen';

// Legal documents (`/settings/legal?doc=tos|privacy`) — thin shell.
export default function SettingsLegalRoute() {
  const { doc } = useLocalSearchParams<{ doc?: string }>();
  return <LegalScreen doc={(doc === 'privacy' ? 'privacy' : 'tos') as LegalDoc} />;
}
