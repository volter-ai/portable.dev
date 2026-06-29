import { TunnelDetailScreen } from '@/features/runtime';

// `/runtime/tunnel/:port` — tunnel detail (Apple-compliant preview/open).
// The screen reads `port` from the route via useLocalSearchParams.
export default function RuntimeTunnelDetailRoute() {
  return <TunnelDetailScreen />;
}
