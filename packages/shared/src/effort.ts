import type { ModelMode } from './models.js';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface EffortConfig {
  value: EffortLevel;
  label: string;
  description: string;
  color: string;
  hoverColor: string;
}

export const EFFORT_LEVELS: Record<EffortLevel, EffortConfig> = {
  low: {
    value: 'low',
    label: 'Low',
    description: 'Minimal thinking, fastest responses',
    color: '#3b82f6',
    hoverColor: '#60a5fa',
  },
  medium: {
    value: 'medium',
    label: 'Medium',
    description: 'Moderate thinking',
    color: '#22c55e',
    hoverColor: '#4ade80',
  },
  high: {
    value: 'high',
    label: 'High',
    description: 'Deep reasoning (default)',
    // Theme-safe neutral gray (the PERMISSIONS 'default' precedent) — the old
    // translucent-white "default" sentinel from the dark web UI rendered
    // white-on-white on light themes.
    color: '#6b7280',
    hoverColor: '#9ca3af',
  },
  xhigh: {
    value: 'xhigh',
    label: 'X-High',
    description: 'Deeper than high',
    color: '#f59e0b',
    hoverColor: '#fbbf24',
  },
  max: {
    value: 'max',
    label: 'Max',
    description: 'Maximum effort',
    color: '#ef4444',
    hoverColor: '#f87171',
  },
} as const;

export const DEFAULT_EFFORT_LEVEL: EffortLevel = 'high';

export const EFFORT_LEVEL_MODES: readonly EffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

/**
 * Per-model effort support (Anthropic docs, verified against the pinned SDK):
 * Fable and Opus support the full range, Sonnet supports everything except
 * 'xhigh', Haiku doesn't accept the `effort` parameter at all.
 */
export const MODEL_EFFORT_SUPPORT: Record<ModelMode, readonly EffortLevel[]> = {
  fable: EFFORT_LEVEL_MODES,
  opus: EFFORT_LEVEL_MODES,
  sonnet: ['low', 'medium', 'high', 'max'],
  haiku: [],
} as const;

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVEL_MODES as readonly string[]).includes(value);
}

export function getEffortConfig(level: EffortLevel): EffortConfig {
  return EFFORT_LEVELS[level];
}

/** The effort levels a model accepts (empty when the model doesn't support effort at all). */
export function getSupportedEffortLevels(model: ModelMode): readonly EffortLevel[] {
  return MODEL_EFFORT_SUPPORT[model];
}

export function modelSupportsEffort(model: ModelMode): boolean {
  return MODEL_EFFORT_SUPPORT[model].length > 0;
}
