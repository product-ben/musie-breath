import { describe, expect, it } from 'vitest';
import { FFT_SIZE } from './config';
import {
  bandBins,
  bandPowers,
  detrendedFlatnessDb,
  extractFeatures,
  flatnessDbOf,
  hasSignal,
  rmsOf,
  rmsToDb,
} from './features';
import type { Floor } from './features';

const SAMPLE_RATE = 48000;
const BINS = bandBins(SAMPLE_RATE, FFT_SIZE);
const BIN_COUNT = FFT_SIZE / 2;

/** A spectrum that is flat at `db` across every bin. */
function flatSpectrum(db: number): Float32Array {
  return new Float32Array(BIN_COUNT).fill(db);
}

/** A spectrum shaped like a given per-band dB level. */
function shaped(lowDb: number, midDb: number, highDb: number): Float32Array {
  const out = new Float32Array(BIN_COUNT).fill(-140);
  for (let k = BINS.low[0]; k <= BINS.low[1]; k += 1) out[k] = lowDb;
  for (let k = BINS.mid[0]; k <= BINS.mid[1]; k += 1) out[k] = midDb;
  for (let k = BINS.high[0]; k <= BINS.high[1]; k += 1) out[k] = highDb;
  return out;
}

function floorFrom(binsDb: Float32Array, rmsDb: number): Floor {
  // Reuse the real band summation so the floor is consistent with the frame.
  return {
    rmsDb,
    binPower: new Float32Array(BIN_COUNT),
    bandPower: bandPowers(binsDb, BINS),
    rmsIqrDb: 1,
    flatnessDb: -3,
    sampleRate: SAMPLE_RATE,
    fftSize: FFT_SIZE,
    framesUsed: 72,
    at: 0,
  };
}

describe('bandBins', () => {
  it('puts at least ten bins in the low band — the reason fftSize is 2048', () => {
    expect(BINS.low[1] - BINS.low[0]).toBeGreaterThanOrEqual(9);
  });

  it('derives different bins at a different sample rate', () => {
    const at44 = bandBins(44100, FFT_SIZE);
    expect(at44.high[1]).not.toBe(BINS.high[1]);
  });
});

describe('hasSignal', () => {
  it('is false only for an exactly-zero window — the dead-graph signature', () => {
    expect(hasSignal(new Float32Array(64))).toBe(false);
    const nearlySilent = new Float32Array(64);
    nearlySilent[33] = 1e-7;
    expect(hasSignal(nearlySilent)).toBe(true);
  });
});

describe('flatnessDbOf', () => {
  it('is exactly 0 for a noiseless flat spectrum', () => {
    expect(flatnessDbOf(flatSpectrum(-50), 10, 300)).toBeCloseTo(0, 6);
  });

  it('goes strongly negative for a single-bin tone', () => {
    const tone = new Float32Array(BIN_COUNT).fill(-120);
    tone[100] = -20;
    expect(flatnessDbOf(tone, 10, 300)).toBeLessThan(-30);
  });

  /**
   * The trap: getFloatFrequencyData hands back -Infinity for an empty bin, and
   * one of those makes the mean NaN, which disarms the detector silently in a
   * quiet room. MIN_BIN_DB is the clamp that prevents it.
   */
  it('returns a finite number for an all--Infinity spectrum', () => {
    const dead = new Float32Array(BIN_COUNT).fill(Number.NEGATIVE_INFINITY);
    const result = flatnessDbOf(dead, 0, BIN_COUNT - 1);
    expect(Number.isFinite(result)).toBe(true);
  });
});

describe('rms', () => {
  it('measures a full-scale sine at about -3 dBFS', () => {
    const n = 2048;
    const sine = new Float32Array(n);
    for (let i = 0; i < n; i += 1) sine[i] = Math.sin((2 * Math.PI * 100 * i) / SAMPLE_RATE);
    expect(rmsToDb(rmsOf(sine))).toBeCloseTo(-3.01, 1);
  });

  it('floors silence instead of returning -Infinity', () => {
    expect(Number.isFinite(rmsToDb(rmsOf(new Float32Array(256))))).toBe(true);
  });
});

describe('extractFeatures', () => {
  const quietFloor = shaped(-90, -90, -90);

  it('reports no shape when the excess is too small to subtract a floor from', () => {
    const f = extractFeatures({
      timeDomain: new Float32Array([0.001, -0.001]),
      binsDb: quietFloor,
      floor: floorFrom(quietFloor, -60),
      bins: BINS,
      at: 100,
      dt: 16.7,
      shapeValidExcessDb: 6,
    });
    expect(f.shape).toBeNull();
  });

  it('reads a breath-shaped spectrum as low-weighted and not sibilant', () => {
    const breath = shaped(-40, -52, -62);
    const f = extractFeatures({
      timeDomain: new Float32Array([0.2, -0.2, 0.18, -0.19]),
      binsDb: breath,
      floor: floorFrom(quietFloor, -60),
      bins: BINS,
      at: 100,
      dt: 16.7,
      shapeValidExcessDb: 6,
    });
    expect(f.shape).not.toBeNull();
    expect(f.shape!.highRatio).toBeLessThan(0.3);
  });

  it('reads an /s/-shaped spectrum as high-weighted', () => {
    const ess = shaped(-70, -55, -35);
    const f = extractFeatures({
      timeDomain: new Float32Array([0.2, -0.2, 0.18, -0.19]),
      binsDb: ess,
      floor: floorFrom(quietFloor, -60),
      bins: BINS,
      at: 100,
      dt: 16.7,
      shapeValidExcessDb: 6,
    });
    expect(f.shape!.highRatio).toBeGreaterThan(0.6);
    expect(f.shape!.lowRatio).toBeLessThan(0.1);
  });

  /**
   * The point of subtracting the floor before taking ratios: a steady fan is
   * present in both the floor and the frame, so it should contribute almost
   * nothing to the shape of what is NEW.
   */
  it('subtracts a steady fan out of the shape', () => {
    const fan = shaped(-45, -55, -80);
    const breathOverFan = shaped(-44.5, -48, -62);
    const f = extractFeatures({
      timeDomain: new Float32Array([0.2, -0.2]),
      binsDb: breathOverFan,
      floor: floorFrom(fan, -55),
      bins: BINS,
      at: 100,
      dt: 16.7,
      shapeValidExcessDb: 6,
    });
    /* The fan dominates the raw low band; after subtraction the mid-band
       breath energy is what the ratio describes. */
    expect(f.shape!.lowRatio).toBeLessThan(0.5);
  });
});

describe('detrendedFlatnessDb', () => {
  /**
   * The whole point of detrending, and the thing a plain flatness measure gets
   * wrong: a SMOOTH spectrum with a steep slope has no tonality at all, and
   * must not be reported as tonal. Measured on a real device, the plain
   * measure read -12.8 dB for exactly this shape and -10.7 dB for voiced
   * speech — i.e. it ranked a tilted noise as MORE tonal than a voice.
   */
  it('is near the noise ceiling for a steeply tilted but smooth spectrum', () => {
    const tilted = new Float32Array(BIN_COUNT);
    for (let k = 0; k < BIN_COUNT; k += 1) tilted[k] = -20 - k * 0.35;
    const plain = flatnessDbOf(tilted, 13, 128);
    const detrended = detrendedFlatnessDb(tilted, 13, 128);

    expect(plain).toBeLessThan(-8);        // the plain measure is fooled
    expect(detrended).toBeCloseTo(0, 4);   // detrending sees straight through it
  });

  it('still goes negative for real tonality on top of a tilt', () => {
    const harmonic = new Float32Array(BIN_COUNT);
    for (let k = 0; k < BIN_COUNT; k += 1) {
      harmonic[k] = -20 - k * 0.35 + (k % 5 === 0 ? 14 : 0);
    }
    expect(detrendedFlatnessDb(harmonic, 13, 128)).toBeLessThan(-3);
  });

  it('survives an all--Infinity spectrum', () => {
    const dead = new Float32Array(BIN_COUNT).fill(Number.NEGATIVE_INFINITY);
    expect(Number.isFinite(detrendedFlatnessDb(dead, 13, 128))).toBe(true);
  });

  it('returns 0 rather than dividing by zero on too few bins', () => {
    expect(detrendedFlatnessDb(new Float32Array(BIN_COUNT), 10, 11)).toBe(0);
  });
});
