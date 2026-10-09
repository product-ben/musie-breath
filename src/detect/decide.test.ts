import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './config';
import type { DetectorConfig } from './config';
import { initialDetectorState, stepDetector } from './decide';
import type { DetectorState } from './decide';
import type { FeatureFrame, Shape } from './features';

/**
 * Each case is a sentence that must not be a lie. The style is musie's
 * features/voice/src/capture/health.test.ts: one fixture, move one thing at a
 * time, and no mocking of anything — the function under test is pure.
 */

/**
 * Fixture shapes, set to the values actually MEASURED through a fake capture
 * device on 2026-10-09 rather than to guesses. Each distractor is shaped so
 * that exactly one gate rejects it, which is what makes a failure here point
 * at the gate that broke.
 */
/** Detrended flatness sits at the ~-2.5 dB noise ceiling; low-weighted. */
const BREATH: Shape = { lowRatio: 0.36, highRatio: 0.12, flatnessDb: -2.4 };
/** Rejected by flatness AND by lowRatio — voiced speech fails both. */
const SPEECH: Shape = { lowRatio: 0.18, highRatio: 0.02, flatnessDb: -6.8 };
/** Noise-like, so flatness PASSES. Only highRatio can reject it. */
const SIBILANT: Shape = { lowRatio: 0.05, highRatio: 0.7, flatnessDb: -2.5 };

function frame(at: number, dt: number, excessDb: number, shape: Shape | null): FeatureFrame {
  return {
    at,
    dt,
    rmsDb: -60 + excessDb,
    excessDb,
    shape,
    extras: { centroidHz: 800, attackDb: 0, plainFlatnessDb: -8 },
  };
}

/** Drive a run of identical frames at a given frame rate. */
function run(
  state: DetectorState,
  opts: { ms: number; hz: number; excessDb: number; shape: Shape | null; from: number },
  config: DetectorConfig = DEFAULT_CONFIG,
): { state: DetectorState; at: number } {
  const dt = 1000 / opts.hz;
  let at = opts.from;
  let next = state;
  const end = opts.from + opts.ms;
  while (at < end) {
    at += dt;
    next = stepDetector(next, frame(at, dt, opts.excessDb, opts.shape), config);
  }
  return { state: next, at };
}

describe('stepDetector', () => {
  it('ignores a 30 ms spike — a tap is not a breath', () => {
    const { state } = run(initialDetectorState(0), {
      ms: 30, hz: 60, excessDb: 40, shape: BREATH, from: 0,
    });
    expect(state.phase).not.toBe('breathing');
    expect(state.completed).toBe(0);
  });

  it('reaches breathing once a qualifying run passes minOnsetMs', () => {
    const { state } = run(initialDetectorState(0), {
      ms: 500, hz: 60, excessDb: 20, shape: BREATH, from: 0,
    });
    expect(state.phase).toBe('breathing');
    expect(state.breathing).toBe(true);
  });

  it('does not reach breathing just short of minOnsetMs', () => {
    const { state } = run(initialDetectorState(0), {
      ms: 330, hz: 60, excessDb: 20, shape: BREATH, from: 0,
    });
    expect(state.phase).toBe('onset');
    expect(state.breathing).toBe(false);
  });

  it('survives a two-frame dropout mid-breath — breathing stays true', () => {
    const a = run(initialDetectorState(0), {
      ms: 600, hz: 60, excessDb: 20, shape: BREATH, from: 0,
    });
    expect(a.state.phase).toBe('breathing');

    const b = run(a.state, { ms: 34, hz: 60, excessDb: 0, shape: null, from: a.at });
    expect(b.state.phase).toBe('release');
    expect(b.state.breathing).toBe(true);
    expect(b.state.completed).toBe(0);
  });

  it('a dropout longer than releaseMs ends the breath exactly once', () => {
    const a = run(initialDetectorState(0), {
      ms: 1000, hz: 60, excessDb: 20, shape: BREATH, from: 0,
    });
    const b = run(a.state, { ms: 400, hz: 60, excessDb: 0, shape: null, from: a.at });

    expect(b.state.phase).toBe('idle');
    expect(b.state.breathing).toBe(false);
    expect(b.state.completed).toBe(1);
    /* Measured to where the sound stopped, not to where our patience ran out. */
    expect(b.state.lastDurationMs).toBeGreaterThan(900);
    expect(b.state.lastDurationMs).toBeLessThan(1100);

    /* And it stays one: more silence must not count a second breath. */
    const c = run(b.state, { ms: 1000, hz: 60, excessDb: 0, shape: null, from: b.at });
    expect(c.state.completed).toBe(1);
  });

  it('a run that decays below onset but above sustain keeps breathing (hysteresis)', () => {
    const a = run(initialDetectorState(0), {
      ms: 500, hz: 60, excessDb: 13, shape: BREATH, from: 0,
    });
    expect(a.state.phase).toBe('breathing');

    const b = run(a.state, { ms: 500, hz: 60, excessDb: 8, shape: BREATH, from: a.at });
    expect(b.state.phase).toBe('breathing');
    expect(b.state.breathing).toBe(true);
  });

  it('a fresh run at sustain level never starts — the other half of hysteresis', () => {
    const { state } = run(initialDetectorState(0), {
      ms: 2000, hz: 60, excessDb: 8, shape: BREATH, from: 0,
    });
    expect(state.phase).toBe('idle');
    expect(state.completed).toBe(0);
  });

  it('rejects voiced speech however loud it is', () => {
    const { state } = run(initialDetectorState(0), {
      ms: 3000, hz: 60, excessDb: 30, shape: SPEECH, from: 0,
    });
    expect(state.phase).toBe('idle');
    expect(state.completed).toBe(0);
  });

  it('rejects a long sibilant — /s/ is noise-like but lives too high', () => {
    const { state } = run(initialDetectorState(0), {
      ms: 3000, hz: 60, excessDb: 25, shape: SIBILANT, from: 0,
    });
    expect(state.phase).toBe('idle');
    expect(state.completed).toBe(0);
  });

  it('blocks sustained noise instead of counting it, and clears when it stops', () => {
    const a = run(initialDetectorState(0), {
      ms: 15000, hz: 60, excessDb: 20, shape: BREATH, from: 0,
    });
    expect(a.state.phase).toBe('blocked');
    expect(a.state.breathing).toBe(false);
    expect(a.state.intensity).toBe(0);
    /* A hairdryer must not inflate the breath count. */
    expect(a.state.completed).toBe(0);

    const b = run(a.state, { ms: 200, hz: 60, excessDb: 0, shape: null, from: a.at });
    expect(b.state.phase).toBe('idle');
  });

  it('a null shape sustains a breath but can never start one', () => {
    const started = run(initialDetectorState(0), {
      ms: 2000, hz: 60, excessDb: 30, shape: null, from: 0,
    });
    expect(started.state.phase).toBe('idle');

    const real = run(initialDetectorState(0), {
      ms: 500, hz: 60, excessDb: 20, shape: BREATH, from: 0,
    });
    const sustained = run(real.state, {
      ms: 100, hz: 60, excessDb: 20, shape: null, from: real.at,
    });
    expect(sustained.state.breathing).toBe(true);
  });

  /**
   * ProMotion. iPhone 13 Pro and later tick rAF at up to 120 Hz, so a fixed
   * per-frame smoothing constant would make the visual feel twice as fast on
   * one phone as on another. This is the test that pins alpha to dt.
   */
  it('smooths identically at 60 Hz and 120 Hz', () => {
    const a = run(initialDetectorState(0), {
      ms: 500, hz: 60, excessDb: 20, shape: BREATH, from: 0,
    });
    const b = run(initialDetectorState(0), {
      ms: 500, hz: 120, excessDb: 20, shape: BREATH, from: 0,
    });
    expect(Math.abs(a.state.levelDb - b.state.levelDb)).toBeLessThan(0.5);
    expect(Math.abs(a.state.intensity - b.state.intensity)).toBeLessThan(0.05);
  });

  it('intensity rises during onset, before breathing is committed', () => {
    const { state } = run(initialDetectorState(0), {
      ms: 200, hz: 60, excessDb: 25, shape: BREATH, from: 0,
    });
    expect(state.phase).toBe('onset');
    expect(state.breathing).toBe(false);
    /* The whole reason a 350 ms gate is affordable. */
    expect(state.intensity).toBeGreaterThan(0.3);
  });
});
