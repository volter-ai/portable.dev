/**
 * Shared Sentry configuration builder.
 * Returns a plain config object — does NOT import any Sentry SDK.
 * Each service passes this config to their own Sentry.init().
 */

export interface SentryConfigInput {
  service: string;
  dsn: string | undefined;
  environment?: string;
}

export interface SentryConfig {
  dsn: string;
  environment: string;
  attachStacktrace: false;
  sendDefaultPii: false;
  sampleRate: 1.0;
  enableTracing: false;
  autoSessionTracking: false;
  initialScope: {
    tags: { service: string };
  };
  beforeSend: (event: any) => any | null;
}

export function buildSentryConfig(input: SentryConfigInput): SentryConfig | null {
  if (!input.dsn) {
    return null;
  }

  return {
    dsn: input.dsn,
    environment: input.environment ?? 'dev',
    attachStacktrace: false,
    sendDefaultPii: false,
    sampleRate: 1.0,
    enableTracing: false,
    autoSessionTracking: false,
    initialScope: {
      tags: { service: input.service },
    },
    beforeSend(event: any) {
      // Only allow error and fatal level events
      if (event.level !== 'error' && event.level !== 'fatal') {
        return null;
      }

      // Strip breadcrumbs and extra data
      delete event.breadcrumbs;
      delete event.extra;

      return event;
    },
  };
}
