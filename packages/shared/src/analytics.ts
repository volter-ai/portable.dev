/**
 * Analytics System
 *
 * Typesafe analytics with multiple channel support.
 * Falls back to console logging if not configured.
 */

/**
 * Define all analytics events and their parameters here.
 * This ensures type safety across the entire analytics system.
 */
export interface AnalyticsEvents {
  // Pricing events
  'purchase-intent': {
    planId: string;
    userId: string;
    type: 'monthly' | 'yearly';
    value: number;
    currency: 'USD';
  };
  'pricing-plan-selected': {
    plan: 'free' | 'pro';
    userId?: string;
    timestamp: number;
  };
  'pricing-plan-changed': {
    fromPlan: 'free' | 'pro';
    toPlan: 'free' | 'pro';
    userId?: string;
    timestamp: number;
  };
  'pricing-continue-clicked': {
    selectedPlan: 'free' | 'pro';
    isPaidPlan: boolean;
    userId?: string;
    timestamp: number;
  };
  'pricing-sold-out-shown': {
    plan: 'free' | 'pro';
    userId?: string;
    timestamp: number;
  };
  'pricing-free-fallback': {
    originalPlan: 'free' | 'pro';
    userId?: string;
    timestamp: number;
  };

  // Onboarding survey events
  'onboarding-survey-started': {
    surveyType: 'language' | 'theme' | 'role' | 'devtools' | 'interests';
    userId?: string;
    timestamp: number;
  };
  'onboarding-survey-completed': {
    surveyType: 'language' | 'theme' | 'role' | 'devtools' | 'interests';
    answers: string[];
    userId?: string;
    timestamp: number;
    timeSpentMs?: number;
  };
  'onboarding-survey-changed': {
    surveyType: 'language' | 'theme' | 'role' | 'devtools' | 'interests';
    selected: string[];
    userId?: string;
    timestamp: number;
  };
  'onboarding-survey-skipped': {
    surveyType: 'language' | 'theme' | 'role' | 'devtools' | 'interests';
    userId?: string;
    timestamp: number;
    timeSpentMs?: number;
  };
  'onboarding-flow-started': {
    userId?: string;
    timestamp: number;
  };
  'onboarding-flow-completed': {
    userId?: string;
    timestamp: number;
    totalTimeMs: number;
    answers: {
      language: string;
      theme: string;
      roles: string[];
      devtools: string[];
      interests: string[];
    };
  };
  'onboarding-step-viewed': {
    step: 'loading' | 'language' | 'theme' | 'role' | 'devtools' | 'interests' | 'video' | 'complete';
    userId?: string;
    timestamp: number;
  };
  'onboarding-back-clicked': {
    fromStep: string;
    toStep: string;
    userId?: string;
    timestamp: number;
  };
  'onboarding-video-started': {
    videoIndex: number;
    videoUrl: string;
    userId?: string;
    timestamp: number;
  };
  'onboarding-video-completed': {
    videoIndex: number;
    videoUrl: string;
    userId?: string;
    timestamp: number;
  };
  'onboarding-machine-name-submitted': {
    machineName: string;
    userId?: string;
    timestamp: number;
  };
}

/**
 * Base interface for analytics channels
 */
interface AnalyticsChannel {
  name: string;
  track<K extends keyof AnalyticsEvents>(
    event: K,
    properties: AnalyticsEvents[K]
  ): void | Promise<void>;
}

/**
 * Google Analytics channel configuration
 */
interface GoogleAnalyticsConfig {
  gtag?: (event: string, properties: Record<string, any>) => void; // Client-side gtag function
}

/**
 * Facebook Pixel channel configuration
 */
interface FacebookPixelConfig {
  fbq?: (event: string, properties: Record<string, any>) => void; // Client-side fbq function
}

/**
 * Google Analytics channel
 * 
 * Client-side only (gtag.js)
 * 
 * Usage:
 * ```ts
 * const gaChannel = new GoogleAnalyticsChannel({
 *   gtag: (event, properties) => {
 *     (window as any).gtag('event', event, properties);
 *   }
 * });
 */
class GoogleAnalyticsChannel implements AnalyticsChannel {
  name = 'Google Analytics';
  private config: GoogleAnalyticsConfig;

  constructor(config: GoogleAnalyticsConfig) {
    this.config = config;
  }

  track<K extends keyof AnalyticsEvents>(
    event: K,
    properties: AnalyticsEvents[K]
  ): void {
    // Client-side tracking (gtag.js)
    if (!this.config.gtag) return;

    this.config.gtag(event, properties);
  }
}

/**
 * Facebook Pixel channel
 * 
 * Client-side only (fbq)
 * 
 * Usage:
 * ```ts
 * const fbPixelChannel = new FacebookPixelChannel({
 *   fbq: (event, properties) => {
 *     (window as any).fbq('track', event, properties);
 *   }
 * });
 * ```
 */
class FacebookPixelChannel implements AnalyticsChannel {
  name = 'Facebook Pixel';
  private config: FacebookPixelConfig;

  constructor(config: FacebookPixelConfig) {
    this.config = config;
  }

  track<K extends keyof AnalyticsEvents>(
    event: K,
    properties: AnalyticsEvents[K]
  ): void {
    // Client-side tracking (fbq)
    if (!this.config.fbq) return;

    this.config.fbq(event, properties);
  }
}

/**
 * Console logger channel (fallback when no channels configured)
 */
class ConsoleChannel implements AnalyticsChannel {
  name = 'Console';

  track<K extends keyof AnalyticsEvents>(
    _event: K,
    _properties: AnalyticsEvents[K]
  ): void {
    // Silent in test/dev mode
  }
}

// ============================================================================
// Analytics Configuration
// ============================================================================

export interface AnalyticsConfig {
  googleAnalytics?: GoogleAnalyticsConfig;
  facebookPixel?: FacebookPixelConfig;
  log?: boolean;
}

/**
 * Main Analytics class
 *
 * Usage:
 * ```ts
 * const analytics = new Analytics({
 *   googleAnalytics: {
 *     gtag: (event, properties) => {
 *       (window as any).gtag('event', event, properties);
 *     }
 *   },
 *   facebookPixel: {
 *     fbq: (event, properties) => {
 *       (window as any).fbq('track', event, properties);
 *     }
 *   }
 * });
 *
 * analytics.track('purchase-intent', {
 *   plan: 'pro-monthly',
 *   userId: 'user-123'
 * });
 * ```
 */
export class Analytics {
  private _channels: AnalyticsChannel[] = [];
  private _useConsole = false;

  constructor(config?: AnalyticsConfig) {
    if (!config || config.log) {
      this._channels.push(new ConsoleChannel());
      this._useConsole = true;
    }

    // Initialize configured channels
    if (config?.googleAnalytics) {
      this._channels.push(new GoogleAnalyticsChannel(config.googleAnalytics));
    }

    if (config?.facebookPixel) {
      this._channels.push(new FacebookPixelChannel(config.facebookPixel));
    }
  }

  configure(config: AnalyticsConfig) {
    if (config.googleAnalytics) {
      this._channels = this._channels.filter(c => c.name !== 'Google Analytics');
      this._channels.push(new GoogleAnalyticsChannel(config.googleAnalytics));
    }

    if (config.facebookPixel) {
      this._channels = this._channels.filter(c => c.name !== 'Facebook Pixel');
      this._channels.push(new FacebookPixelChannel(config.facebookPixel));
    }

    if (config.log && !this._useConsole) {
      this._channels.push(new ConsoleChannel());
      this._useConsole = true;
    }
  }

  /**
   * Track an analytics event across all configured channels
   *
   * @param event - Event name (must be defined in AnalyticsEvents interface)
   * @param properties - Event properties (type-checked against event definition)
   */
  async track<K extends keyof AnalyticsEvents>(
    event: K,
    properties: AnalyticsEvents[K]
  ): Promise<void> {
    try {
      const tracks = this._channels.map(channel =>
        channel.track(event, properties)
      );

      // Send to all channels simultaneously
      await Promise.allSettled(tracks);
    } catch (error) {
      console.error('[Analytics] Error tracking event:', error);
    }
  }

  /**
   * Get list of configured channel names
   */
  get channels(): string[] {
    return this._channels.map(c => c.name);
  }

  /**
   * Check if analytics is using console fallback
   */
  get isUsingConsole(): boolean {
    return this._useConsole;
  }
}
