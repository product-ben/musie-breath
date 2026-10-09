import {
  IMPLAUSIBLY_LOW_FLOOR_DB,
  MAX_FLOOR_DB,
  MAX_FLOOR_IQR_DB,
  MIN_BIN_DB,
} from './config';
import { bandPowers, dbToPower, detrendedFlatnessDb, rmsOf, rmsToDb } from './features';
import type { BandBins, Floor } from './features';

/**
 * Measuring the room, so every threshold can be relative to it.
 *
 * Absolute thresholds cannot work. The same exhale into the same phone differs
 * by an order of magnitude between a bedroom and a train, and "captured
 * automatically" is the premise — so nobody can be asked to set a slider
 * first. musie's CLIENT_SILENCE_LEVEL = 0.02 is an absolute -34 dBFS that its
 * own open-questions log admits was never calibrated; this is the alternative.
 */

/** One frame's worth of raw material. Collected during the calibration window. */
export type CalibrationSample = {
  readonly timeDomain: Float32Array;
  readonly binsDb: Float32Array;
};

export type CalibrationFailure = 'noFrames' | 'silentGraph' | 'roomTooLoud' | 'roomUnstable';

export type CalibrationResult =
  | { readonly ok: true; readonly floor: Floor; readonly implausiblyQuiet: boolean }
  | { readonly ok: false; readonly code: CalibrationFailure; readonly floorDb: number };

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * Frames in, a floor out — or a reason why this room cannot be used.
 *
 * MEDIAN, NOT MEAN, throughout. A door closing during the window moves a
 * median by at most one frame's worth and a mean by ten decibels or more, and
 * a floor that is 10 dB too high silently disarms the detector for the rest of
 * the session.
 */
export function calibrate(
  samples: readonly CalibrationSample[],
  bins: BandBins,
  fftSize: number,
  at: number,
): CalibrationResult {
  if (samples.length === 0) {
    return { ok: false, code: 'noFrames', floorDb: Number.NEGATIVE_INFINITY };
  }

  /**
   * The calibration window IS the proof that the graph renders.
   *
   * A live microphone always has at least an LSB of noise, so if no sample in
   * 1.5 s was ever non-zero, audio never arrived — which is a completely
   * different fact from "the room is quiet", and the one musie's bug reported
   * as the latter.
   */
  const anySignal = samples.some((s) => s.timeDomain.some((v) => v !== 0));
  if (!anySignal) {
    return { ok: false, code: 'silentGraph', floorDb: Number.NEGATIVE_INFINITY };
  }

  const rmsDbs = samples.map((s) => rmsToDb(rmsOf(s.timeDomain)));
  const rmsDb = median(rmsDbs);
  const sortedRms = [...rmsDbs].sort((a, b) => a - b);
  const rmsIqrDb = quantile(sortedRms, 0.75) - quantile(sortedRms, 0.25);

  if (rmsDb > MAX_FLOOR_DB) {
    return { ok: false, code: 'roomTooLoud', floorDb: rmsDb };
  }
  if (rmsIqrDb > MAX_FLOOR_IQR_DB) {
    return { ok: false, code: 'roomUnstable', floorDb: rmsDb };
  }

  /**
   * PER-BIN medians, summed into bands.
   *
   * Strictly better than three per-band medians, because a fan's blade tone is
   * then accounted for in the one bin it occupies rather than smeared across a
   * whole band. ~341 bins x ~72 frames sorted once is a few milliseconds, once.
   */
  const binCount = samples[0].binsDb.length;
  const binPower = new Float32Array(binCount);
  const scratch: number[] = new Array(samples.length);
  for (let k = 0; k < binCount; k += 1) {
    for (let f = 0; f < samples.length; f += 1) {
      scratch[f] = dbToPower(Math.max(samples[f].binsDb[k], MIN_BIN_DB));
    }
    binPower[k] = median(scratch);
  }

  const floorDbSpectrum = new Float32Array(binCount);
  for (let k = 0; k < binCount; k += 1) {
    floorDbSpectrum[k] = 10 * Math.log10(Math.max(binPower[k], 1e-20));
  }

  return {
    ok: true,
    implausiblyQuiet: rmsDb < IMPLAUSIBLY_LOW_FLOOR_DB,
    floor: {
      rmsDb,
      binPower,
      bandPower: bandPowers(floorDbSpectrum, bins),
      rmsIqrDb,
      flatnessDb: detrendedFlatnessDb(floorDbSpectrum, bins.flatness[0], bins.flatness[1]),
      sampleRate: bins.sampleRate,
      fftSize,
      framesUsed: samples.length,
      at,
    },
  };
}
