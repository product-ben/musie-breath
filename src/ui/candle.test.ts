import { describe, expect, it } from 'vitest';
import { DEFAULT_CANDLE, initialCandle, isOverdriven, nextCandle } from './candle';
import type { CandleConfig, CandleState } from './candle';

const C: CandleConfig = DEFAULT_CANDLE;

/** Run a steady input for a while at a given frame rate. */
function hold(
  state: CandleState,
  opts: { ms: number; intensity: number; peak: number; hz?: number },
): CandleState {
  const dt = 1000 / (opts.hz ?? 60);
  let next = state;
  let overdrivenFor = 0;
  for (let t = 0; t < opts.ms; t += dt) {
    overdrivenFor = isOverdriven(opts, C) ? overdrivenFor + dt : 0;
    next = nextCandle(next, opts, dt, C, overdrivenFor);
  }
  return next;
}

describe('nextCandle', () => {
  it('burns steadily when nothing is happening', () => {
    const s = hold(initialCandle(), { ms: 2000, intensity: 0, peak: 0.01 });
    expect(s.phase).toBe('lit');
    expect(s.life).toBeCloseTo(1, 2);
    expect(s.lean).toBeCloseTo(0, 2);
    expect(s.turbulence).toBeCloseTo(0, 2);
  });

  /** The middle regime: it should dance, and stay alight. */
  it('leans and churns at mid intensity without going out', () => {
    const s = hold(initialCandle(), { ms: 1200, intensity: 0.5, peak: 0.3 });
    expect(s.phase).toBe('lit');
    expect(s.lean).toBeGreaterThan(0.4);
    expect(s.turbulence).toBeGreaterThan(0.3);
    expect(s.blowouts).toBe(0);
  });

  it('goes out when the input is clipping', () => {
    const s = hold(initialCandle(), { ms: 400, intensity: 0.6, peak: 1 });
    expect(s.phase).toBe('out');
    expect(s.blowouts).toBe(1);
    expect(s.life).toBeLessThan(0.1);
    expect(s.smoke).toBeGreaterThan(0.5);
  });

  it('goes out on an overwhelming breath even without hard clipping', () => {
    const s = hold(initialCandle(), { ms: 400, intensity: 0.95, peak: 0.5 });
    expect(s.phase).toBe('out');
  });

  /**
   * The hold is why this is not a bare comparison. One clipped sample is a
   * tap on the case, not a breath, and a flame that dies at random is noise
   * rather than feedback.
   */
  it('survives a single clipped frame', () => {
    let s = initialCandle();
    s = nextCandle(s, { intensity: 0.2, peak: 1 }, 16.7, C, 16.7);
    expect(s.phase).toBe('lit');
    expect(s.blowouts).toBe(0);
  });

  it('relights once it is quiet again, and not before', () => {
    const out = hold(initialCandle(), { ms: 400, intensity: 0.6, peak: 1 });
    expect(out.phase).toBe('out');

    /* Still being blown at: it must stay out however long it waits. */
    const stillWindy = hold(out, { ms: 4000, intensity: 0.6, peak: 0.6 });
    expect(stillWindy.phase).toBe('out');

    const calm = hold(stillWindy, { ms: 2500, intensity: 0, peak: 0.01 });
    expect(calm.phase).toBe('lit');
    expect(calm.life).toBeCloseTo(1, 2);
  });

  it('will not relight before the delay has passed', () => {
    const out = hold(initialCandle(), { ms: 400, intensity: 0.6, peak: 1 });
    const tooSoon = hold(out, { ms: 600, intensity: 0, peak: 0.01 });
    expect(tooSoon.phase).toBe('out');
  });

  it('can be blown out again during the catch', () => {
    const out = hold(initialCandle(), { ms: 400, intensity: 0.6, peak: 1 });
    const catching = hold(out, { ms: 1500, intensity: 0, peak: 0.01 });
    expect(catching.phase).toBe('relighting');
    const again = hold(catching, { ms: 200, intensity: 0.6, peak: 1 });
    expect(again.phase).toBe('out');
    expect(again.blowouts).toBe(2);
  });

  it('leaves smoke that outlives the flame', () => {
    const out = hold(initialCandle(), { ms: 400, intensity: 0.6, peak: 1 });
    expect(out.life).toBeLessThan(0.1);
    expect(out.smoke).toBeGreaterThan(out.life);
  });

  /** ProMotion again: a Pro phone must not blow the candle out twice as fast. */
  it('behaves the same at 60 Hz and 120 Hz', () => {
    const a = hold(initialCandle(), { ms: 500, intensity: 0.5, peak: 0.3, hz: 60 });
    const b = hold(initialCandle(), { ms: 500, intensity: 0.5, peak: 0.3, hz: 120 });
    expect(Math.abs(a.lean - b.lean)).toBeLessThan(0.03);
    expect(Math.abs(a.turbulence - b.turbulence)).toBeLessThan(0.03);
  });
});
