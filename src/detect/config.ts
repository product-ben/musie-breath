/**
 * Every dial in the detector, in one file, each with its reasoning.
 *
 * The convention is borrowed from musie's features/voice/src/config.ts: a
 * number whose justification lives somewhere else is a number nobody dares
 * change. Each constant below is marked DERIVED or GUESS.
 *
 *   DERIVED — follows from signal processing or physiology. Change it only
 *             with an argument.
 *   GUESS   — a plausible starting point that needs a real iPhone. These are
 *             what the tuning panel exists to move, and what this spike is
 *             for.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * ANALYSIS WINDOW
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * DERIVED. At 48 kHz this is a 42.7 ms window with 23.44 Hz bins.
 *
 * It cannot be smaller. The low band (60–300 Hz) is the feature that says "this
 * sound was blown at the phone", and AnalyserNode applies a Blackman window
 * whose main lobe spreads roughly +/-3 bins. At fftSize 1024 the bins are
 * 46.9 Hz and that band is 5 bins wide — essentially all main-lobe leakage off
 * DC. At 2048 it is 10 bins, which survives the leakage.
 *
 * It gains nothing by being larger: 4096 is an 85 ms window, long relative to
 * the 350 ms onset gate, and the extra frequency resolution is spent inside
 * bands we sum over anyway.
 */
export const FFT_SIZE = 2048;

/**
 * DERIVED, and the zero is deliberate.
 *
 * Three reasons not to let AnalyserNode smooth for us:
 *
 * 1. Its smoothing is a SYMMETRIC one-pole EMA. It slows attack by exactly as
 *    much as it slows release, which is the opposite of what the detector
 *    wants (see ATTACK_TAU_MS / RELEASE_TAU_MS).
 * 2. It would hide what the raw features look like, and the raw features are
 *    this spike's entire product.
 * 3. It is not needed. For one unsmoothed frame of noise each bin's log-power
 *    has sigma ~= 5.57 dB, so averaging over 1024 bins pins the geometric mean
 *    to about +/-0.17 dB. Averaging ACROSS BINS has already done the job that
 *    averaging across time would do.
 */
export const SMOOTHING_TIME_CONSTANT = 0;

/**
 * DERIVED. getFloatFrequencyData returns -Infinity for a bin with no energy,
 * and one -Infinity makes the flatness mean NaN, which kills the detector in
 * total silence — a failure that looks like "it just doesn't work".
 *
 * -140 dB is below any real microphone's noise floor, so clamping there
 * changes no real measurement.
 */
export const MIN_BIN_DB = -140;

/* ────────────────────────────────────────────────────────────────────────────
 * BANDS, in Hz. Bin indices are derived at runtime from context.sampleRate,
 * never hardcoded — a floor measured at 44.1 kHz is invalid at 48 kHz.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * DERIVED, both edges.
 *
 * Lower edge 60 Hz, not 20: iOS high-passes its input somewhere around
 * 50–80 Hz (higher still under voice processing), so the first two bins hold
 * almost nothing — and skipping them also skips the Blackman main lobe
 * spreading off DC.
 *
 * Upper edge 300 Hz, not 250: the airflow-impingement component extends past
 * 250, and 300 buys two more bins of a band that only has ten. It does graze
 * the first formant of /u/, which is the known cost.
 */
export const LOW_BAND_HZ = [60, 300] as const;

/** DERIVED by exclusion — what is left between the low band and /s/. */
export const MID_BAND_HZ = [300, 4000] as const;

/** DERIVED. Where /s/ and /sh/ put their energy and breath does not. */
export const HIGH_BAND_HZ = [4000, 8000] as const;

/**
 * The band flatness is measured over — NARROWER THAN THE OTHERS, AND NOT BY
 * ACCIDENT. Measured 2026-10-09, and it is the one number in this file that
 * was changed by evidence rather than chosen by argument.
 *
 * Spectral flatness as a geometric/arithmetic mean ratio conflates two
 * completely different things:
 *
 *   1. TONALITY — harmonic peaks and nulls. This is what we want, because it
 *      is what separates voiced speech from noise.
 *   2. SPECTRAL TILT — the overall slope. This has nothing to do with
 *      tonality, and a perfectly smooth spectrum with a steep slope reads as
 *      "peaked" anyway.
 *
 * Breath is INHERENTLY TILTED — that is the entire premise of the low-band
 * feature — so a flatness measured across 300–8000 Hz penalises breath for
 * being breath. Driven with synthetic breath through a fake capture device,
 * the wide band read -18.9 dB against a -18 dB threshold and the detector
 * flickered across it continuously, never holding the 350 ms onset.
 *
 * 300–3000 Hz is 3.3 octaves instead of 4.75, so a given slope costs ~30%
 * less flatness, while keeping the region where voiced harmonics are most
 * deeply resolved. The tilt contribution shrinks and the tonality
 * contribution does not, which is exactly the trade wanted.
 */
export const FLATNESS_BAND_HZ = [300, 3000] as const;

/* ────────────────────────────────────────────────────────────────────────────
 * CALIBRATION
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * DERIVED. iOS voice processing converges over the first few hundred ms, and
 * an AudioContext begins rendering asynchronously, so the opening frames
 * describe a system still settling. Discarded rather than detected.
 */
export const CALIBRATION_DISCARD_MS = 300;

/**
 * DERIVED. ~72 frames at 60 Hz. Long enough to span two cycles of a 2 Hz room
 * fluctuation and about five syllabic periods; short enough to read as a
 * moment rather than a wait.
 */
export const CALIBRATION_MEASURE_MS = 1200;

/**
 * DERIVED, and the equality with CALIBRATION_DISCARD_MS + CALIBRATION_MEASURE_MS
 * is the point: the window that measures the room IS the window that proves
 * the graph is rendering. One window, three outcomes — a dead graph, an
 * impossible room, or a usable floor — and no second state machine.
 *
 * 1500 ms is musie's figure and musie's reasoning: ~90 frames is unambiguous,
 * while 1000 ms is within reach of a long GC pause, and a watchdog that cries
 * wolf gets ignored until it is useless.
 */
export const SILENT_GRAPH_MS = 1500;

/**
 * GUESS, from sound arithmetic. A close exhale with AGC off peaks somewhere
 * around -10 dBFS. Detection needs the floor plus ONSET_EXCESS_DB plus ~10 dB
 * of margin to fit underneath that, so the floor has to sit below about
 * -32 dBFS. The arithmetic is sound; the -10 dBFS breath ceiling is the
 * guessed input.
 */
export const MAX_FLOOR_DB = -33;

/**
 * GUESS in its value, DERIVED in its existence. A room whose level swings 9 dB
 * inside 1.2 s — someone talking nearby, music — will cross any floor-relative
 * threshold without help from a breath.
 *
 * This is a DIFFERENT FACT from "too loud" with a different remedy (wait, vs
 * move somewhere else), so it gets its own failure code.
 */
export const MAX_FLOOR_IQR_DB = 9;

/**
 * GUESS. Either a very quiet room or a half-dead capture graph. Not a failure
 * — a flag on the readout, so the tester knows to doubt the numbers.
 */
export const IMPLAUSIBLY_LOW_FLOOR_DB = -75;

/* ────────────────────────────────────────────────────────────────────────────
 * THE DECISION
 * ──────────────────────────────────────────────────────────────────────────── */

export type DetectorConfig = {
  readonly onsetExcessDb: number;
  readonly sustainExcessDb: number;
  readonly shapeValidExcessDb: number;
  readonly minLowRatio: number;
  readonly maxHighRatio: number;
  readonly maxFlatnessDb: number;
  readonly minOnsetMs: number;
  readonly maxBreathMs: number;
  readonly releaseMs: number;
  readonly attackTauMs: number;
  readonly releaseTauMs: number;
  readonly intensityFloorDb: number;
  readonly intensityCeilDb: number;
};

export const DEFAULT_CONFIG: DetectorConfig = {
  /**
   * GUESS, half-derived. A stationary noise's 42.7 ms RMS wanders +/-1.5 dB; a
   * lively room +/-4–6 dB. So 12 dB is roughly 2–3 sigma of a lively room,
   * and far below the 25–40 dB excess a close exhale is expected to produce.
   * The floor-variance half follows from signal processing; the breath-level
   * half is the guess.
   */
  onsetExcessDb: 12,

  /**
   * GUESS in absolute terms, DERIVED in its relation to onset. The 5 dB gap is
   * the conventional audio-gate hysteresis and corresponds to about the last
   * 30% of an exhale's decay. THE GAP IS THE ROBUST PART; the absolute pair is
   * not.
   */
  sustainExcessDb: 7,

  /**
   * DERIVED. Below this much excess, floor-subtracted band energies are
   * dominated by the floor's own variance and the shape ratios are noise.
   *
   * Deliberately set BELOW sustainExcessDb so that in the default
   * configuration shape is always available whenever the level gate passes.
   * The null branch in frameQualifies still exists and is still tested,
   * because the tuning panel can drag sustainExcessDb underneath this and
   * make it live.
   */
  shapeValidExcessDb: 6,

  /**
   * MEASURED 2026-10-09 against synthetic signals through a fake capture
   * device, and still the shakiest number in this file.
   *
   *     realistic breath   0.23 .. 0.65   (mean 0.36)
   *     voiced speech      0.17 .. 0.20   (mean 0.18)
   *
   * 0.22 passes every breath frame and rejects every speech frame, but the
   * margin on the speech side is 0.02 and that is thin. It is affordable only
   * because detrended flatness is now a working second gate that also rejects
   * speech — a false positive has to pass both.
   *
   * The physical caveat stands: this is the "blown at the phone" evidence,
   * coming from air hitting the diaphragm directly, which only happens within
   * about 15 cm. If it is absent at a natural holding distance it has to come
   * out of the decision altogether, and the detector loses its only proximity
   * evidence. That is open question 1 of the three.
   */
  minLowRatio: 0.22,

  /**
   * GUESS, positioned by derivation. Breath is expected below 0.2 and /s/
   * above 0.6, so the midpoint leaves margin both ways.
   */
  maxHighRatio: 0.30,

  /**
   * MEASURED 2026-10-09, and the number that moved furthest from theory.
   *
   * This now gates DETRENDED flatness (see detrendedFlatnessDb), which
   * measures tonality with the spectral tilt removed. The theoretical ceiling
   * for real noise is about -2.5 dB, not 0, because for exponentially
   * distributed bin power E[ln X] = ln(mean) - gamma.
   *
   *     realistic breath    -3.64 .. -1.64   (mean -2.4, i.e. at the ceiling)
   *     steeply tilted noise -4.17 .. -2.00   (mean -2.8, also at the ceiling)
   *     voiced speech       -8.43 .. -4.31   (mean -6.8)
   *
   * -4.0 passes every breath frame with 0.36 dB to spare and fails every
   * speech frame by 0.31 dB. Tight, but the two noise signals converging on
   * the ceiling DESPITE very different tilts is the thing that makes this
   * feature trustworthy at all.
   *
   * Theory predicted -20 to -35 dB for voiced speech and it reads -6.8. At
   * 23 Hz bins a 120 Hz F0 puts harmonics about 5 bins apart, and the
   * Blackman window's main lobe spans roughly +/-3, so adjacent harmonics
   * smear together and fill the nulls that the prediction assumed. A larger
   * fftSize would deepen them, at the cost of a longer window.
   */
  maxFlatnessDb: -4.0,

  /**
   * DERIVED. A finger tap is 10–40 ms, a case knock with ringing up to 80 ms,
   * a cough 100–400 ms. 350 ms rejects taps with certainty and most coughs.
   *
   * IT COSTS NO FELT LATENCY, which is what makes it affordable: `intensity`
   * is decoupled from the `breathing` boolean and is already climbing all the
   * way through `onset`, so the visual responds immediately and only the
   * boolean waits.
   */
  minOnsetMs: 350,

  /**
   * GUESS, and as much a product decision as a measurement. A comfortable
   * exhale is 3–8 s; a deliberate one 15–20 s. 12 s is long enough that nobody
   * doing what this spike is about gets cut off, short enough that a hairdryer
   * cannot pin the visual on indefinitely.
   */
  maxBreathMs: 12000,

  /**
   * DERIVED. Sits in the gap between intra-breath turbulence wobble (10–30 ms)
   * and the shortest real pause between breaths (>= 400 ms, since an inhale
   * has to happen). So a two-frame dropout cannot end a breath and a real
   * pause always can.
   */
  releaseMs: 180,

  /**
   * DERIVED. 63% in 60 ms, 95% in 180 ms. Feedback reads as caused by your own
   * action inside roughly 100–150 ms, so this lands within that budget while
   * still removing the few dB of frame-to-frame jitter a 42.7 ms window has.
   */
  attackTauMs: 60,

  /**
   * GUESS in value, DERIVED in ratio. ~1 s to 95% decay: long enough to glide
   * over a turbulence dip rather than flicker, short enough that the end of a
   * breath reads as an end. The ~6:1 release:attack ratio is the robust part.
   */
  releaseTauMs: 350,

  /**
   * DERIVED, and the fact that it is BELOW onsetExcessDb is the whole trick:
   * the visual starts moving before the detector commits, which is what makes
   * it feel alive and what pays for the generous minOnsetMs above.
   */
  intensityFloorDb: 6,

  /** GUESS. The excess at which the visual is considered fully driven. */
  intensityCeilDb: 30,
};

/* ────────────────────────────────────────────────────────────────────────────
 * WATCHDOGS
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * DERIVED, musie's reasoning verbatim: ~90 consecutive all-zero frames is
 * unambiguous, 1000 ms is within reach of a GC pause.
 */
export const CAPTURE_LOST_MS = 1500;

/**
 * DERIVED. A 1 s gap between rAF ticks WHILE THE PAGE IS VISIBLE is already
 * pathological. While hidden it is not a fault at all — it is the documented
 * limitation of sampling features on rAF.
 */
export const NO_FRAMES_MS = 1000;

/**
 * GUESS, pure UI timing. About four breath cycles. After this, "no breath has
 * ever been detected" stops being a state we are waiting out and becomes the
 * finding worth reporting.
 */
export const NEVER_TRIGGERED_MS = 20000;
