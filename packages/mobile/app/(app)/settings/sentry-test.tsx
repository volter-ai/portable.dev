import { SentryTestScreen } from '@/features/observability/SentryTestScreen';

/**
 * `/settings/sentry-test` — the dev-mode Sentry verification page (#1394). The
 * route stays registered always; it is only SURFACED from the settings root while
 * the hidden dev mode (#1384) is on (see `SettingsScreen`'s dev entry).
 */
export default function SentryTestRoute() {
  return <SentryTestScreen />;
}
