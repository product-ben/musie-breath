import type { DetectorConfig } from './config';
import type { FeatureFrame } from './features';

/**
 * The decision. Pure: no clock, no audio, no React, no timers, no randomness.
 *
 * Everything that can be WRONG about this detector is in this file, which is
 * why it is the one with a real test suite. The argument is musie's, from
 * apps/web/src/lib/voiceScreen.ts and from the post-mortem in
 * docs/VOICE-CAPTURE-FIX.md: the bug that cost a day was a confusion between
 * two predicates, and a pure function over fixture values is exactly what
 * makes such a confusion visible before a device ever sees it.
 */

export type DetectorPhase = 'idle' | 'onset' | 'breathing' | 'release' | 'blocked';

/** Readout only. Never branched on. Exists so a transition can be explained. */
export type TransitionReason =
  | 'start'
  | 'frame-qualified'
  | 'onset-held'
  | 'onset-abandoned'
  | 'frame-failed'
  | 'release-recovered'
  | 'release-expired'
  | 'too-long'
  | 'blocked-cleared'
  | 'holding';

export type DetectorState = {
  readonly phase: DetectorPhase;
  /** When the current PHASE was entered. */
  readonly since: number;
  /**
   * When the current candidate RUN began — the clock the duration gates read.
   *
   * Deliberately distinct from `since`: a brief dropout moves the phase to
   * `release` and back without restarting the run, so a breath that wobbles is
   * still one breath of the full length.
   */
  readonly runSince: number;
  /** Asymmetrically smoothed dB over floor. */
  readonly levelDb: number;
  /** 0..1, for the visual. */
  readonly intensity: number;
  /** True in `breathing` AND `release`. The boolean the app acts on. */
  readonly breathing: boolean;
  readonly reason: TransitionReason;
  readonly completed: number;
  readonly lastDurationMs: number | null;
};

export function initialDetectorState(atMs: number): DetectorState {
  return {
    phase: 'idle',
    since: atMs,
    runSince: atMs,
    levelDb: 0,
    intensity: 0,
    breathing: false,
    reason: 'start',
    completed: 0,
    lastDurationMs: null,
  };
}

/**
 * Does this one frame look like breath?
 *
 * Extracted because it is the part that gets fiddled with most, and because
 * the `holding` asymmetry below is subtle enough to deserve its own name.
 */
export function frameQualifies(
  frame: FeatureFrame,
  config: DetectorConfig,
  /** Inside a breath a frame needs only the lower, sustain threshold. */
  holding: boolean,
): boolean {
  const need = holding ? config.sustainExcessDb : config.onsetExcessDb;
  if (frame.excessDb < need) return false;

  /**
   * Loud enough, but too quiet for the shape ratios to mean anything.
   *
   * SUSTAIN an existing breath; never START one. The asymmetry is the point:
   * absent evidence may keep a claim alive but may not open it. This is the
   * same discipline as keeping "we stopped hearing" apart from "you are not
   * breathing", applied one level down.
   */
  if (frame.shape === null) return holding;

  return (
    frame.shape.lowRatio >= config.minLowRatio &&
    frame.shape.highRatio <= config.maxHighRatio &&
    frame.shape.flatnessDb >= config.maxFlatnessDb
  );
}

function smoothLevel(
  previousDb: number,
  frame: FeatureFrame,
  config: DetectorConfig,
): number {
  const target = Math.max(0, frame.excessDb);
  const tau = target > previousDb ? config.attackTauMs : config.releaseTauMs;
  /**
   * alpha from dt, NOT a fixed per-frame constant.
   *
   * iPhone 13 Pro and later run ProMotion, so rAF ticks at up to 120 Hz. A
   * fixed alpha would make the visual feel exactly twice as fast on a Pro
   * phone as on a non-Pro one — a platform-dependent feel bug that is very
   * hard to see and impossible to tune around.
   */
  const alpha = 1 - Math.exp(-frame.dt / tau);
  return previousDb + alpha * (target - previousDb);
}

function intensityOf(levelDb: number, config: DetectorConfig): number {
  const span = config.intensityCeilDb - config.intensityFloorDb;
  if (span <= 0) return 0;
  const t = (levelDb - config.intensityFloorDb) / span;
  return Math.max(0, Math.min(1, t));
}

/** One frame in, the next state out. */
export function stepDetector(
  state: DetectorState,
  frame: FeatureFrame,
  config: DetectorConfig,
): DetectorState {
  const levelDb = smoothLevel(state.levelDb, frame, config);
  const base = {
    levelDb,
    intensity: intensityOf(levelDb, config),
    completed: state.completed,
    lastDurationMs: state.lastDurationMs,
  };

  const holding = state.phase === 'onset' || state.phase === 'breathing' || state.phase === 'release';
  const qualifies = frameQualifies(frame, config, holding || state.phase === 'blocked');

  switch (state.phase) {
    case 'idle': {
      if (!qualifies) {
        return { ...state, ...base, phase: 'idle', breathing: false };
      }
      return {
        ...state,
        ...base,
        phase: 'onset',
        since: frame.at,
        runSince: frame.at,
        breathing: false,
        reason: 'frame-qualified',
      };
    }

    case 'onset': {
      /**
       * NO GRACE IN ONSET, deliberately. A cough is a single loud burst that
       * fails within two or three frames; giving onset a release window would
       * let a cough plus room ambience limp over the minOnsetMs line and count
       * as a breath.
       */
      if (!qualifies) {
        return {
          ...state,
          ...base,
          phase: 'idle',
          since: frame.at,
          breathing: false,
          reason: 'onset-abandoned',
        };
      }
      if (frame.at - state.runSince >= config.minOnsetMs) {
        return {
          ...state,
          ...base,
          phase: 'breathing',
          since: frame.at,
          breathing: true,
          reason: 'onset-held',
        };
      }
      return { ...state, ...base, phase: 'onset', breathing: false, reason: 'holding' };
    }

    case 'breathing': {
      if (qualifies && frame.at - state.runSince >= config.maxBreathMs) {
        /**
         * `blocked` exists so a vacuum cleaner or a hairdryer — sustained,
         * noise-like, low-tilted, and therefore perfectly qualifying — cannot
         * pin the visual on for a minute.
         *
         * It is also an HONEST STATE the UI has to surface: "a continuous
         * sound is being treated as noise" is a different sentence from "you
         * are not breathing", and conflating them is the whole mistake this
         * detector is built to avoid.
         */
        return {
          ...state,
          ...base,
          phase: 'blocked',
          since: frame.at,
          intensity: 0,
          breathing: false,
          reason: 'too-long',
        };
      }
      if (qualifies) {
        return { ...state, ...base, phase: 'breathing', breathing: true, reason: 'holding' };
      }
      return {
        ...state,
        ...base,
        phase: 'release',
        since: frame.at,
        breathing: true,
        reason: 'frame-failed',
      };
    }

    case 'release': {
      if (qualifies) {
        /* runSince UNCHANGED: the dropout was inside one breath, not between two. */
        return {
          ...state,
          ...base,
          phase: 'breathing',
          since: frame.at,
          breathing: true,
          reason: 'release-recovered',
        };
      }
      if (frame.at - state.since >= config.releaseMs) {
        return {
          ...state,
          ...base,
          phase: 'idle',
          since: frame.at,
          breathing: false,
          reason: 'release-expired',
          completed: state.completed + 1,
          /**
           * Measured to WHERE THE DROPOUT STARTED, not to where release
           * expired. The breath ended when the sound did; releaseMs is our
           * patience, not the person's breath.
           */
          lastDurationMs: state.since - state.runSince,
        };
      }
      return { ...state, ...base, phase: 'release', breathing: true, reason: 'holding' };
    }

    case 'blocked': {
      if (!qualifies) {
        return {
          ...state,
          ...base,
          phase: 'idle',
          since: frame.at,
          intensity: 0,
          breathing: false,
          reason: 'blocked-cleared',
        };
      }
      /* Intensity forced to 0: we have decided to disbelieve this sound, and
         the visual must agree with the decision rather than contradict it. */
      return { ...state, ...base, phase: 'blocked', intensity: 0, breathing: false, reason: 'holding' };
    }
  }
}
