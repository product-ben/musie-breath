import { CAPTURE_LOST_MS, NEVER_TRIGGERED_MS, NO_FRAMES_MS } from './config';

/**
 * Two questions, two functions, and they are never allowed to answer each
 * other's.
 *
 * This file is the architectural lesson of musie's docs/VOICE-CAPTURE-FIX.md
 * applied before the bug rather than after it. That bug was ONE PREDICATE
 * REPORTING TWO DIFFERENT FACTS — "no audio has arrived" and "the room is
 * quiet" shared a code path, and the app told people they had gone silent when
 * in truth it had stopped listening.
 *
 * So: captureVerdict answers "are we hearing anything at all", detectionVerdict
 * answers "is this person breathing out". Neither can reach the other's
 * vocabulary, and the UI renders them as two separate chips that never merge.
 */

export type CaptureFailure =
  /* ── could not open ──────────────────────────────────────────────────── */
  | 'permissionDenied'
  | 'noDevice'
  | 'deviceBusy'
  | 'constraintsRejected'
  | 'trackArrivedDead'
  | 'insecureContext'
  /* ── opened, and no audio is reaching the analyser ───────────────────── */
  | 'silentGraph'
  | 'noFrames'
  /* ── audio arrived, and it is unusable ───────────────────────────────── */
  | 'roomTooLoud'
  | 'roomUnstable'
  /**
   * The track is louder at the microphone than anything a person can do, so
   * subtraction has nothing to work with. A DIFFERENT FACT from a loud room:
   * the remedy is headphones or less volume, not a quieter building.
   */
  | 'trackDrowningMic'
  /* ── was working, then stopped ───────────────────────────────────────── */
  | 'trackMuted'
  | 'trackEnded'
  | 'contextInterrupted'
  | 'captureLost';

export type CaptureStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'opening' }
  | { readonly kind: 'reopening' }
  | { readonly kind: 'calibrating'; readonly framesDone: number; readonly framesNeeded: number }
  /** The pink-noise burst that measures speaker-to-microphone coupling. */
  | { readonly kind: 'measuringLeak'; readonly framesDone: number; readonly framesNeeded: number }
  | { readonly kind: 'listening' }
  | { readonly kind: 'failed'; readonly code: CaptureFailure; readonly detail?: string };

/** Is this failure worth offering a retry for, or is it terminal? */
export function isRecoverable(code: CaptureFailure): boolean {
  switch (code) {
    case 'permissionDenied':
    case 'noDevice':
    case 'insecureContext':
      return false;
    case 'trackDrowningMic':
      /* Recoverable by turning the volume down or putting headphones in,
         which is a thing the person can actually do. */
      return true;
    default:
      return true;
  }
}

export type CaptureLiveness = {
  readonly now: number;
  /** performance.now() of the last rAF tick we processed. */
  readonly lastFrameAt: number;
  /** The last tick in which SOME sample was non-zero. Capture is alive. */
  readonly lastSignalAt: number;
  /** document.visibilityState === 'hidden'. */
  readonly hidden: boolean;
};

/**
 * Still hearing?
 *
 * The two refs are the fix musie had to make: `lastFrameAt` means the main
 * thread is alive, `lastSignalAt` means the AUDIO thread is. One ref for both
 * is the defect.
 */
export function captureVerdict(s: CaptureLiveness): 'live' | 'noFrames' | 'captureLost' | 'paused' {
  /**
   * Hidden is NOT a failure. rAF stops when the page is hidden or the screen
   * sleeps, which is the documented cost of sampling features on rAF rather
   * than in a worklet. Reporting it as a fault would be a lie about the
   * platform.
   */
  if (s.hidden) return 'paused';
  if (s.now - s.lastFrameAt >= NO_FRAMES_MS) return 'noFrames';
  if (s.now - s.lastSignalAt >= CAPTURE_LOST_MS) return 'captureLost';
  return 'live';
}

export type DetectionVerdict = 'detecting' | 'waiting' | 'never-triggered' | 'noise-rejected';

/**
 * Anything being detected?
 *
 * `never-triggered` IS NOT A FAILURE and must never render as one. It is this
 * spike's primary finding: the microphone worked, the room was fine, and a
 * breath still did not register. That is the result, not an error.
 */
export function detectionVerdict(s: {
  readonly listeningForMs: number;
  readonly completed: number;
  readonly blocked: boolean;
}): DetectionVerdict {
  if (s.blocked) return 'noise-rejected';
  if (s.completed > 0) return 'detecting';
  return s.listeningForMs >= NEVER_TRIGGERED_MS ? 'never-triggered' : 'waiting';
}
