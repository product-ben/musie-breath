import {
  FLATNESS_BAND_HZ,
  HIGH_BAND_HZ,
  LOW_BAND_HZ,
  MID_BAND_HZ,
  MIN_BIN_DB,
} from './config';

/**
 * Turning one analyser frame into four numbers. Pure, and the only file that
 * knows what a decibel is.
 *
 * ── ONE TRAP, STATED ONCE ───────────────────────────────────────────────────
 * Time-domain RMS in dB and frequency-domain band power in dB differ by a
 * constant (window coherent gain plus the FFT's normalisation). NEVER COMPARE
 * ONE TO THE OTHER. The level gate uses time-domain RMS only; the shape
 * features use frequency-domain RATIOS only, where that constant cancels.
 * Somebody will eventually try to put a band energy on the same axis as
 * rmsDb — this comment is why they should not.
 */

/** Which bins each band covers, for one particular sample rate and fftSize. */
export type BandBins = {
  readonly low: readonly [number, number];
  readonly mid: readonly [number, number];
  readonly high: readonly [number, number];
  /** Narrower than the others on purpose — see FLATNESS_BAND_HZ. */
  readonly flatness: readonly [number, number];
  readonly sampleRate: number;
  readonly binCount: number;
};

/**
 * Bin indices for the three bands.
 *
 * Derived at runtime rather than hardcoded because the sample rate is whatever
 * iOS decides to give us — this spike deliberately does not request one — and
 * band edges in Hz land on different bins at 44.1 kHz than at 48 kHz.
 */
export function bandBins(sampleRate: number, fftSize: number): BandBins {
  const binCount = fftSize / 2;
  const nyquist = sampleRate / 2;
  const binOf = (hz: number) =>
    Math.max(0, Math.min(binCount - 1, Math.round((hz / nyquist) * binCount)));

  const edge = (band: readonly [number, number]): readonly [number, number] => [
    binOf(band[0]),
    binOf(band[1]),
  ];

  return {
    low: edge(LOW_BAND_HZ),
    mid: edge(MID_BAND_HZ),
    high: edge(HIGH_BAND_HZ),
    flatness: edge(FLATNESS_BAND_HZ),
    sampleRate,
    binCount,
  };
}

/** What the room sounds like with nobody breathing at it. See calibrate.ts. */
export type Floor = {
  readonly rmsDb: number;
  /** Per-bin median LINEAR power. Summed into bands, never used per-bin. */
  readonly binPower: Float32Array;
  readonly bandPower: readonly [number, number, number];
  readonly rmsIqrDb: number;
  readonly flatnessDb: number;
  readonly sampleRate: number;
  readonly fftSize: number;
  readonly framesUsed: number;
  readonly at: number;
};

export type Shape = {
  /** 0..1. Share of NEW energy below 300 Hz — "blown at the phone". */
  readonly lowRatio: number;
  /** 0..1. Share of NEW energy above 4 kHz — the /s/ rejector. */
  readonly highRatio: number;
  /** <= 0 dB. Geometric over arithmetic mean. 0 flat, -30 tonal. */
  readonly flatnessDb: number;
};

export type FeatureFrame = {
  /** performance.now(). NEVER Date.now() — that clock can step. */
  readonly at: number;
  /** ms since the previous frame. Every smoothing coefficient derives from it. */
  readonly dt: number;
  readonly rmsDb: number;
  /** rmsDb minus the floor's. The level gate reads only this. */
  readonly excessDb: number;
  /**
   * Largest absolute sample in the window, 0..1.
   *
   * Not used by the detector — RMS is what the gates read. It is here because
   * "übersteuert" is a real, measurable thing rather than a synonym for loud:
   * a peak at 1.0 means the converter ran out of range and the waveform is
   * being flattened. Blowing hard straight at a phone microphone with auto
   * gain off does exactly that, which is what the candle's blowout reads.
   */
  readonly peak: number;
  /**
   * null when excessDb is too small for floor subtraction to mean anything.
   *
   * NULL MEANS NO EVIDENCE. It must never be read as evidence of absence —
   * see frameQualifies in decide.ts, where null sustains an existing breath
   * and is not allowed to start one.
   */
  readonly shape: Shape | null;
  /** Readout only, never read by the decision. */
  readonly extras: {
    readonly centroidHz: number;
    readonly attackDb: number;
    /**
     * Flatness WITHOUT detrending. Carried only so the tilt-versus-tonality
     * split is visible on a real phone: the gap between this and
     * shape.flatnessDb IS the spectral tilt, which is itself a useful
     * measurement of how close the phone is to the mouth.
     */
    readonly plainFlatnessDb: number;
  };
};

export function dbToPower(db: number): number {
  return Math.pow(10, db / 10);
}

export function rmsOf(timeDomain: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < timeDomain.length; i += 1) sum += timeDomain[i] * timeDomain[i];
  return Math.sqrt(sum / timeDomain.length);
}

/** Largest absolute sample. Clipping shows up here and nowhere else. */
export function peakOf(timeDomain: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < timeDomain.length; i += 1) {
    const v = timeDomain[i] < 0 ? -timeDomain[i] : timeDomain[i];
    if (v > peak) peak = v;
  }
  return peak;
}

export function rmsToDb(rms: number): number {
  return 20 * Math.log10(Math.max(rms, 1e-9));
}

/**
 * Is the audio graph actually rendering?
 *
 * A live microphone always has a noise floor of at least one LSB, so a window
 * in which EVERY sample is exactly 0.0 is the signature of a graph that never
 * started — not of a quiet room.
 *
 * This distinction is the whole reason the function exists. An rAF tick proves
 * the MAIN thread is alive and says nothing whatever about the AUDIO thread;
 * musie's production bug was one predicate answering those two questions, and
 * reporting the flattering one.
 */
export function hasSignal(timeDomain: Float32Array): boolean {
  for (let i = 0; i < timeDomain.length; i += 1) {
    if (timeDomain[i] !== 0) return true;
  }
  return false;
}

/**
 * Spectral flatness over a bin range, in dB.
 *
 * Cheap in a way worth noticing: the analyser already hands back logarithms,
 * and the arithmetic mean of dB IS the geometric mean of power. So the
 * geometric mean needs no logarithms at all — two means and a subtraction.
 *
 * The ceiling is NOT 0 dB. For real noise, bin powers are exponentially
 * distributed and E[ln X] = ln(mean) - gamma, so a perfectly flat random
 * spectrum reads about -2.5 dB. Only a noiseless synthetic flat spectrum
 * reaches 0.
 */
export function flatnessDbOf(binsDb: Float32Array, from: number, to: number): number {
  let sumDb = 0;
  let sumPower = 0;
  let n = 0;
  for (let k = from; k <= to && k < binsDb.length; k += 1) {
    const db = Math.max(binsDb[k], MIN_BIN_DB);
    sumDb += db;
    sumPower += dbToPower(db);
    n += 1;
  }
  if (n === 0) return 0;
  const geoMeanDb = sumDb / n;
  const arithMeanDb = 10 * Math.log10(sumPower / n);
  return geoMeanDb - arithMeanDb;
}

/**
 * Spectral flatness of the DETRENDED spectrum — tilt removed, tonality kept.
 *
 * ── WHY THE PLAIN MEASURE IS NOT ENOUGH, MEASURED 2026-10-09 ───────────────
 * Geometric-over-arithmetic flatness conflates two unrelated things: TONALITY
 * (harmonic peaks and nulls, which is what separates voiced speech from
 * noise) and SPECTRAL TILT (the overall slope, which says nothing about
 * tonality). Over a band of N octaves a smooth spectrum with R dB of tilt
 * costs roughly R/3 dB of flatness all by itself.
 *
 * That confound is fatal here, because BREATH IS INHERENTLY TILTED — it is
 * the entire premise of the low-band feature. Driven through a fake capture
 * device the plain measure read:
 *
 *     realistic breath   -3.6 dB      (gentle tilt)
 *     voiced speech     -10.7 dB
 *     steeply tilted     -12.8 dB     (a smooth spectrum, no tonality at all)
 *
 * So the ordering is wrong: a tilted noise looks MORE tonal than speech. Any
 * single threshold on the plain measure is a coin flip between a breath held
 * close to the phone and a voice.
 *
 * Least-squares fitting a line in dB across the band and measuring the
 * residual removes the tilt term and leaves the tonality term untouched. The
 * mean residual is zero by construction, so the whole measure collapses to
 * the arithmetic mean of the residual powers.
 */
export function detrendedFlatnessDb(
  binsDb: Float32Array,
  from: number,
  to: number,
): number {
  const last = Math.min(to, binsDb.length - 1);
  const n = last - from + 1;
  /* Two points define a line, so a residual needs at least three bins. */
  if (n < 3) return 0;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let k = from; k <= last; k += 1) {
    const x = k - from;
    const y = Math.max(binsDb[k], MIN_BIN_DB);
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  /* mean(residual) is 0 by least squares, so geoMeanDb is 0 and flatness is
     just -arithMeanDb of the residual powers. */
  let sumResidualPower = 0;
  for (let k = from; k <= last; k += 1) {
    const x = k - from;
    const y = Math.max(binsDb[k], MIN_BIN_DB);
    sumResidualPower += dbToPower(y - (intercept + slope * x));
  }
  return -10 * Math.log10(sumResidualPower / n);
}

function bandPowerOf(binsDb: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let k = from; k <= to && k < binsDb.length; k += 1) {
    sum += dbToPower(Math.max(binsDb[k], MIN_BIN_DB));
  }
  return sum;
}

/** All three band powers from one dB spectrum. Shared with calibration. */
export function bandPowers(
  binsDb: Float32Array,
  bins: BandBins,
): [number, number, number] {
  return [
    bandPowerOf(binsDb, bins.low[0], bins.low[1]),
    bandPowerOf(binsDb, bins.mid[0], bins.mid[1]),
    bandPowerOf(binsDb, bins.high[0], bins.high[1]),
  ];
}

/** Readout only. Kept because it is the conventional number people expect. */
function centroidOf(binsDb: Float32Array, bins: BandBins): number {
  const hzPerBin = bins.sampleRate / 2 / bins.binCount;
  let num = 0;
  let den = 0;
  for (let k = bins.low[0]; k <= bins.high[1] && k < binsDb.length; k += 1) {
    const p = dbToPower(Math.max(binsDb[k], MIN_BIN_DB));
    num += p * k * hzPerBin;
    den += p;
  }
  return den === 0 ? 0 : num / den;
}

/**
 * One analyser frame to one FeatureFrame.
 *
 * ── THE SHAPE FEATURES ARE COMPUTED ON EXCESS ENERGY, NOT TOTAL ────────────
 * Each band has the calibrated floor's power subtracted before any ratio is
 * taken, so the ratios describe ONLY WHAT IS NEW IN THE ROOM.
 *
 * This is what makes a fan survivable. A steady fan contributes to numerator
 * and denominator alike in a raw ratio and is therefore invisible to it; after
 * subtraction it contributes ~0 to both, and the ratio describes the breath.
 *
 * Subtraction happens at BAND level, not per bin, on purpose: clamping each
 * bin at zero would bias every band upward (the artefact known as musical
 * noise), whereas clamping three sums does not.
 */
export function extractFeatures(args: {
  timeDomain: Float32Array;
  binsDb: Float32Array;
  floor: Floor;
  bins: BandBins;
  at: number;
  dt: number;
  shapeValidExcessDb: number;
  /** rmsDb from ~80 ms ago, for the readout-only attack figure. */
  previousRmsDb?: number;
  /**
   * The floor to use for THIS frame instead of the calibrated one.
   *
   * Supplied while a track is playing: it is the room floor plus whatever the
   * track's own spectrum predicts is leaking back into the microphone, so a
   * frame containing nothing but the track comes out at zero excess. See
   * detect/coupling.ts.
   */
  floorOverride?: { band: readonly [number, number, number]; rmsDb: number };
}): FeatureFrame {
  const { timeDomain, binsDb, floor, bins, at, dt, shapeValidExcessDb } = args;
  const floorBand = args.floorOverride?.band ?? floor.bandPower;
  const floorRmsDb = args.floorOverride?.rmsDb ?? floor.rmsDb;

  const rmsDb = rmsToDb(rmsOf(timeDomain));
  const excessDb = rmsDb - floorRmsDb;
  const peak = peakOf(timeDomain);

  let shape: Shape | null = null;
  if (excessDb >= shapeValidExcessDb) {
    const now = bandPowers(binsDb, bins);
    const excess: [number, number, number] = [
      Math.max(0, now[0] - floorBand[0]),
      Math.max(0, now[1] - floorBand[1]),
      Math.max(0, now[2] - floorBand[2]),
    ];
    const total = excess[0] + excess[1] + excess[2];
    if (total > 0) {
      shape = {
        lowRatio: excess[0] / total,
        highRatio: excess[2] / total,
        flatnessDb: detrendedFlatnessDb(binsDb, bins.flatness[0], bins.flatness[1]),
      };
    }
  }

  return {
    at,
    dt,
    rmsDb,
    excessDb,
    peak,
    shape,
    extras: {
      centroidHz: centroidOf(binsDb, bins),
      attackDb: args.previousRmsDb === undefined ? 0 : rmsDb - args.previousRmsDb,
      plainFlatnessDb: flatnessDbOf(binsDb, bins.flatness[0], bins.flatness[1]),
    },
  };
}
