/**
 * AI Style settings ViewModel.
 *
 * Pure store page — NO HTTP. The catalog is the shared `@vgit2/shared/aiStyles`
 * `AI_STYLES` record (single source of every label/description); persistence is
 * the MMKV-backed `useChatStore` (`aiStyle` + `customAiStylePrompt`, persist key
 * `portable.chat`).
 *
 * Behaviors:
 *   - Selecting a style persists immediately (`setAiStyle`).
 *   - The custom prompt is edited as a TEMP draft (`useState` seeded from the
 *     persisted value) and committed ONLY on blur (`commitCustomPrompt`) — never
 *     per keystroke (a blur-to-persist write throttle).
 *   - (Re)selecting 'custom' re-seeds the draft from the persisted prompt.
 *
 * Every persistence seam is injectable (`deps`) so the hook is unit-testable
 * without the store; the defaults are the real chatStore setters.
 */

import { useCallback, useMemo, useState } from 'react';
import { AI_STYLES, type AIStyle, type AIStyleMode } from '@vgit2/shared/aiStyles';

import { useChatStore } from '../../../state/chatStore';

export interface AiStyleViewModelDeps {
  /** Persist the selected style (default: `useChatStore.setAiStyle` → MMKV). */
  persistAiStyle?: (style: AIStyleMode) => void;
  /** Persist the custom prompt (default: `useChatStore.setCustomAiStylePrompt` → MMKV). */
  persistCustomPrompt?: (prompt: string) => void;
}

export interface AiStyleViewModel {
  /** The shared style catalog, in `AI_STYLES` declaration order. */
  styles: AIStyle[];
  /** Currently-selected style (live store value). */
  aiStyle: AIStyleMode;
  /** Whether the custom-instructions editor should show. */
  isCustom: boolean;
  /** The uncommitted custom-prompt draft (committed on blur). */
  draftCustomPrompt: string;
  selectStyle: (style: AIStyleMode) => void;
  setDraftCustomPrompt: (text: string) => void;
  /** Blur handler — persists the draft to the store. */
  commitCustomPrompt: () => void;
}

export function useAiStyleViewModel(deps: AiStyleViewModelDeps = {}): AiStyleViewModel {
  const aiStyle = useChatStore((s) => s.aiStyle);
  const customAiStylePrompt = useChatStore((s) => s.customAiStylePrompt);
  const storeSetAiStyle = useChatStore((s) => s.setAiStyle);
  const storeSetCustomPrompt = useChatStore((s) => s.setCustomAiStylePrompt);

  const persistAiStyle = deps.persistAiStyle ?? storeSetAiStyle;
  const persistCustomPrompt = deps.persistCustomPrompt ?? storeSetCustomPrompt;

  // `tempCustomPrompt` — seeded from the persisted prompt at mount.
  const [draftCustomPrompt, setDraftCustomPrompt] = useState(customAiStylePrompt);

  const styles = useMemo(
    () => (Object.keys(AI_STYLES) as AIStyleMode[]).map((id) => AI_STYLES[id]),
    []
  );

  const selectStyle = useCallback(
    (style: AIStyleMode) => {
      persistAiStyle(style);
      // Re-seed the temp prompt when (re)entering the custom style.
      if (style === 'custom') setDraftCustomPrompt(customAiStylePrompt);
    },
    [persistAiStyle, customAiStylePrompt]
  );

  const commitCustomPrompt = useCallback(() => {
    persistCustomPrompt(draftCustomPrompt);
  }, [persistCustomPrompt, draftCustomPrompt]);

  return {
    styles,
    aiStyle,
    isCustom: aiStyle === 'custom',
    draftCustomPrompt,
    selectStyle,
    setDraftCustomPrompt,
    commitCustomPrompt,
  };
}
