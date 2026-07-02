/**
 * Native-dictation ViewModel (local-first voice input).
 *
 * Orchestrates the on-device speech recognizer ({@link NativeSpeechRecognizer}) into the
 * record → live-text → stop → insert flow over an INJECTABLE recognizer seam, so it
 * unit-tests with no native module. Speech→text is entirely on-device — there is NO server
 * round-trip.
 *
 * The streaming "…" feel is LOCAL and instant: native interim results render as the pending
 * buffer with a trailing ellipsis; each FINALIZED utterance is appended. On stop the full
 * transcript (accumulated finals + the trailing interim) is assembled and inserted.
 *
 * A dedicated CUMULATIVE-ECHO GUARD (`findRestatedTailStart` in `handleResult`) absorbs the
 * trailing final / restart-partial that re-states already-committed text — including a late
 * final CUMULATIVE over the whole session, spanning SEVERAL committed segments (possibly with
 * the flushed tail cut mid-word) and/or the in-progress pending chunk. Without it, committed +
 * pending render those phrases TWICE (the "doubled text" bug during pauses/sentence breaks).
 */

import { useCallback, useRef, useState } from 'react';

import type { NativeSpeechRecognizer, SpeechResult } from './nativeSpeechRecognizer';

export type VoicePhase = 'idle' | 'recording' | 'transcribing';

export interface UseNativeDictationDeps {
  /** The on-device recognizer (production = expo-speech-recognition; tests = a fake). */
  recognizer: NativeSpeechRecognizer;
  /** Called with the assembled transcript — the caller inserts it. */
  onTranscription: (text: string) => void;
  /** Mic / speech-recognition permission was denied. */
  onPermissionDenied?: () => void;
  /** Recognition failed. */
  onError?: (error: unknown) => void;
}

export interface NativeDictation {
  phase: VoicePhase;
  isRecording: boolean;
  isTranscribing: boolean;
  /** The live display: accumulated finalized utterances + the pending interim (trailing "…"). */
  liveText: string;
  /** Request permission then begin on-device recognition. */
  start: () => Promise<void>;
  /** Stop recognition, assemble the full transcript, and insert it. */
  stop: () => Promise<void>;
  /** Discard the in-progress dictation without inserting anything. */
  cancel: () => Promise<void>;
}

/**
 * Join committed segments + the in-progress segment into the display. A trailing ellipsis
 * marks text still being recognized (an interim) — once the segment is final it reads as
 * settled text, no ellipsis.
 */
function composeDisplay(segments: string[], pending: string, pendingIsFinal: boolean): string {
  const committed = segments.filter(Boolean).join(' ').trim();
  const trimmedPending = pending.trim();
  if (!trimmedPending) return committed;
  const tail = pendingIsFinal ? trimmedPending : `${trimmedPending}…`;
  return committed ? `${committed} ${tail}` : tail;
}

/** Lowercase + strip punctuation/extra whitespace — for CONTINUATION/dedup comparison only
 * (we always STORE/display the raw transcript, never this normalized form). */
function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does `next` CONTINUE the current segment `current` (cumulative growth / a refinement)
 * rather than begin a brand-new independent segment? iOS keeps results cumulative across
 * an `isFinal` (each result is the WHOLE session so far), so its post-final results
 * continue — they must REPLACE, never append (appending re-adds everything: the
 * "rewrites the whole thing" duplication). Android's segmented continuous mode emits a
 * fresh, independent transcript for the next segment, which does NOT continue.
 */
function continuesSegment(current: string, next: string): boolean {
  if (!current) return true;
  return normalizeForCompare(next).startsWith(normalizeForCompare(current));
}

/**
 * Does `next` merely RE-STATE `prev` — an EXACT echo, or a cumulative EXTENSION (the same
 * words plus more)? Used to catch the post-flush echo that causes the "doubled text" bug: after
 * an utterance-end flush commits a segment and clears `pending`, the just-ended session can
 * deliver a trailing final — or the auto-restarted session its first partial — that re-delivers
 * that segment. Word-boundary-aware (`${p} `) so a shared prefix WORD ("go" vs "google") is not
 * a false match; the exact-equality arm covers the single-word echo. For a MULTI-word `prev`
 * a plain prefix match is also accepted: the flush can commit a partial cut MID-WORD
 * ("…the text evalu"), which the late final then completes ("…the text evaluates") — a
 * word-boundary-only comparison misses that restatement and the phrase doubles.
 */
function restatesSegment(prev: string, next: string): boolean {
  const p = normalizeForCompare(prev);
  const n = normalizeForCompare(next);
  if (!p) return false;
  if (n === p || n.startsWith(`${p} `)) return true;
  // Mid-word truncation tolerance — multi-word `prev` only, so a single shared prefix
  // WORD ("go" vs "google") is still genuine new speech, never an echo.
  return p.includes(' ') && n.startsWith(p);
}

/**
 * Find the start index of the LONGEST tail of `segments` (plus the in-progress `pending`,
 * when non-empty) that `next` re-states or cumulatively extends — the MULTI-SEGMENT echo.
 * Android's engine can emit a late final that is CUMULATIVE over the WHOLE session (its
 * partials reset to just-new words at pauses, committing chunks along the way, then the
 * final re-delivers everything) — so the echo can span SEVERAL committed segments, not just
 * the last one, and can arrive while a chunk is still pending. Returns -1 when no tail
 * matches (every candidate tail includes at least one committed segment — a `pending`-only
 * restatement is the normal REPLACE path, not an echo).
 */
function findRestatedTailStart(segments: string[], pending: string, next: string): number {
  for (let i = 0; i < segments.length; i++) {
    const tail = [...segments.slice(i), pending].filter(Boolean).join(' ');
    if (restatesSegment(tail, next)) return i;
  }
  return -1;
}

/** Commit a finalized segment, dropping an exact consecutive duplicate (guards the
 * iOS `end`-before-final ordering, where a late old-session final re-delivers the text
 * the utterance-end flush already committed). */
function pushSegment(segments: string[], text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const prev = segments[segments.length - 1];
  if (prev && normalizeForCompare(prev) === normalizeForCompare(trimmed)) return;
  segments.push(trimmed);
}

export function useNativeDictation(deps: UseNativeDictationDeps): NativeDictation {
  const { recognizer, onTranscription, onPermissionDenied, onError } = deps;

  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [liveText, setLiveText] = useState('');

  // Guards overlapping start/stop taps (the web hook's "lingering resources" race).
  const busyRef = useRef(false);
  // Finalized segment texts (RAW), in order — committed at segment/session boundaries.
  const segmentsRef = useRef<string[]>([]);
  // The current segment's latest transcript (REPLACE-based — interims grow and the final
  // refines the SAME segment; never blindly appended, or iOS's cumulative results would
  // duplicate the whole transcript).
  const pendingRef = useRef('');
  // Whether the last result for the current segment was final — used to detect when a new
  // independent segment starts (Android segmented mode) vs an iOS cumulative continuation.
  const lastWasFinalRef = useRef(false);
  // Set once stop()/cancel() runs — post-stop engine results are ignored (deterministic).
  const stoppedRef = useRef(false);

  const render = useCallback(() => {
    setLiveText(composeDisplay(segmentsRef.current, pendingRef.current, lastWasFinalRef.current));
  }, []);

  const handleResult = useCallback(
    (result: SpeechResult) => {
      if (stoppedRef.current) return; // ignore trailing post-stop results
      const transcript = result.transcript;
      // CUMULATIVE-ECHO GUARD (fixes the "doubled text" bug). Two shapes: (1) right after an
      // utterance-end/new-segment commit (`pending` empty), the just-ended session's trailing
      // final — or the auto-restarted session's first partial — RE-STATES (or cumulatively
      // extends) what was just committed; (2) mid-session, the engine emits a late final that
      // is CUMULATIVE over the WHOLE session — spanning SEVERAL committed segments plus the
      // in-progress `pending` — even though its partials had been resetting to just-new words.
      // Either way, writing it into `pending` as-is renders/inserts those phrases TWICE.
      // Pop the restated tail back into the in-progress buffer so the REPLACE-based logic
      // below owns it again: an exact echo collapses to one copy, an extension refines it in
      // place — never a double.
      const tailStart = findRestatedTailStart(segmentsRef.current, pendingRef.current, transcript);
      if (tailStart !== -1) {
        segmentsRef.current.length = tailStart;
        pendingRef.current = '';
      }
      // A genuinely NEW segment begins only when the previous result was already FINAL
      // and this transcript does NOT continue it (Android's segmented continuous mode);
      // commit the previous segment first. Otherwise REPLACE the in-progress segment —
      // covering interim growth, the final refining an interim, AND iOS's post-final
      // cumulative results (which would otherwise be appended and re-add everything).
      // A NEW segment begins whenever this result does NOT continue (extend) the current
      // one. The on-device engines reset their partial buffer to JUST the new words after a
      // pause (verified on Samsung: "Hello, hello." → " World."), often with NO `end` event
      // and NO `isFinal` for the whole session — so we must NOT gate this on a prior final,
      // or the new chunk silently REPLACES the previous text (the data-loss bug). A cumulative
      // engine (iOS) always extends, so it never spuriously splits.
      const isNewSegment = !continuesSegment(pendingRef.current, transcript);
      if (isNewSegment) {
        pushSegment(segmentsRef.current, pendingRef.current);
        pendingRef.current = '';
      }
      pendingRef.current = transcript;
      lastWasFinalRef.current = result.isFinal;
      render();
    },
    [render]
  );

  // At each utterance boundary (a pause that ends the session, before the auto-restart),
  // COMMIT the in-progress segment so the next session's partials start fresh. `pushSegment`
  // drops an exact consecutive duplicate (the iOS end-before-final ordering).
  const handleUtteranceEnd = useCallback(() => {
    if (stoppedRef.current) return;
    pushSegment(segmentsRef.current, pendingRef.current);
    pendingRef.current = '';
    lastWasFinalRef.current = false;
    render();
  }, [render]);

  const reset = useCallback(() => {
    segmentsRef.current = [];
    pendingRef.current = '';
    lastWasFinalRef.current = false;
    setLiveText('');
  }, []);

  const start = useCallback(async () => {
    if (busyRef.current || phase !== 'idle') return;
    busyRef.current = true;
    try {
      const granted = await recognizer.requestPermission();
      if (!granted) {
        onPermissionDenied?.();
        return;
      }
      reset();
      stoppedRef.current = false;
      setPhase('recording');
      await recognizer.start({
        onResult: handleResult,
        // Each utterance boundary commits the pending text (pause-safe accumulation).
        onUtteranceEnd: handleUtteranceEnd,
        onError: (error) => onError?.(error),
        // The engine ending on its own is handled by the recognizer's auto-restart;
        // the user taps stop to finalize + insert.
        onEnd: () => {},
      });
    } catch (error) {
      setPhase('idle');
      onError?.(error);
    } finally {
      busyRef.current = false;
    }
  }, [phase, recognizer, handleResult, handleUtteranceEnd, onError, onPermissionDenied, reset]);

  const stop = useCallback(async () => {
    if (busyRef.current || phase !== 'recording') return;
    busyRef.current = true;
    stoppedRef.current = true;
    setPhase('transcribing');
    try {
      await recognizer.stop();
    } catch (error) {
      onError?.(error);
    } finally {
      // Assemble the FULL transcript (committed segments + the trailing in-progress one).
      pushSegment(segmentsRef.current, pendingRef.current);
      pendingRef.current = '';
      const full = segmentsRef.current.filter(Boolean).join(' ').trim();
      if (full) onTranscription(full);
      reset();
      setPhase('idle');
      busyRef.current = false;
    }
  }, [phase, recognizer, onTranscription, onError, reset]);

  const cancel = useCallback(async () => {
    if (phase !== 'recording') return;
    busyRef.current = true;
    stoppedRef.current = true;
    try {
      await recognizer.abort();
    } catch (error) {
      onError?.(error);
    } finally {
      reset();
      setPhase('idle');
      busyRef.current = false;
    }
  }, [phase, recognizer, onError, reset]);

  return {
    phase,
    isRecording: phase === 'recording',
    isTranscribing: phase === 'transcribing',
    liveText,
    start,
    stop,
    cancel,
  };
}
