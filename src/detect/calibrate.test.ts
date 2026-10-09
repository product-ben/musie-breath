import { describe, expect, it } from 'vitest';
import { calibrate } from './calibrate';
import type { CalibrationSample } from './calibrate';
import { FFT_SIZE } from './config';
import { bandBins } from './features';

const BINS = bandBins(48000, FFT_SIZE);
const BIN_COUNT = FFT_SIZE / 2;

function sampleAt(rmsLevel: number, db: number): CalibrationSample {
  const timeDomain = new Float32Array(256);
  for (let i = 0; i < timeDomain.length; i += 1) {
    timeDomain[i] = i % 2 === 0 ? rmsLevel : -rmsLevel;
  }
  return { timeDomain, binsDb: new Float32Array(BIN_COUNT).fill(db) };
}

describe('calibrate', () => {
  it('reports silentGraph for frames that are exactly zero, not a quiet room', () => {
    const dead: CalibrationSample[] = Array.from({ length: 72 }, () => ({
      timeDomain: new Float32Array(256),
      binsDb: new Float32Array(BIN_COUNT).fill(Number.NEGATIVE_INFINITY),
    }));
    const result = calibrate(dead, BINS, FFT_SIZE, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('silentGraph');
  });

  it('reports noFrames when nothing arrived at all', () => {
    const result = calibrate([], BINS, FFT_SIZE, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('noFrames');
  });

  /**
   * The reason the statistic is a median. A door closing during the window
   * must not raise the floor for the whole session.
   */
  it('ignores one loud transient', () => {
    const quiet = Array.from({ length: 71 }, () => sampleAt(0.001, -80));
    const withSlam = [...quiet.slice(0, 35), sampleAt(0.5, -10), ...quiet.slice(35)];

    const clean = calibrate(quiet, BINS, FFT_SIZE, 0);
    const slammed = calibrate(withSlam, BINS, FFT_SIZE, 0);

    expect(clean.ok && slammed.ok).toBe(true);
    if (clean.ok && slammed.ok) {
      expect(Math.abs(clean.floor.rmsDb - slammed.floor.rmsDb)).toBeLessThan(1);
    }
  });

  it('refuses a room that is simply too loud', () => {
    const loud = Array.from({ length: 72 }, () => sampleAt(0.2, -20));
    const result = calibrate(loud, BINS, FFT_SIZE, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('roomTooLoud');
  });

  /** A different fact from "too loud", with a different remedy. */
  it('refuses an unstable room separately from a loud one', () => {
    const swinging: CalibrationSample[] = Array.from({ length: 72 }, (_, i) =>
      sampleAt(i % 2 === 0 ? 0.0005 : 0.02, -70),
    );
    const result = calibrate(swinging, BINS, FFT_SIZE, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('roomUnstable');
  });

  it('flags an implausibly quiet floor without failing', () => {
    const tooQuiet = Array.from({ length: 72 }, () => sampleAt(0.00002, -110));
    const result = calibrate(tooQuiet, BINS, FFT_SIZE, 0);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.implausiblyQuiet).toBe(true);
  });

  it('records the sample rate, because a floor from 44.1k is invalid at 48k', () => {
    const result = calibrate(
      Array.from({ length: 72 }, () => sampleAt(0.001, -80)),
      BINS, FFT_SIZE, 1234,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.floor.sampleRate).toBe(48000);
      expect(result.floor.framesUsed).toBe(72);
    }
  });
});
