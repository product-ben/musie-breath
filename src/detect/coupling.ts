/**
 * How much of what the speaker plays comes back into the microphone.
 *
 * ── WHY THIS FILE HAS TO EXIST ─────────────────────────────────────────────
 * Music is spectrally very close to breath as far as these four features are
 * concerned: a full mix is broadband, bass-weighted (so it passes lowRatio)
 * and noise-like in aggregate (so it passes detrended flatness). Played
 * through the phone's own speaker it arrives at the phone's own microphone a
 * few centimetres away, and the detector fires on the track rather than on the
 * person.
 *
 * The obvious fix — echoCancellation — is the one thing that cannot be used
 * here, because switching it on puts iOS into voice-processing mode, which is
 * exactly the variable this spike exists to measure. So instead: the playback
 * signal is OURS, we can analyse it, and we can subtract what it predicts.
 *
 * ── CALIBRATED WITH PINK NOISE, NOT WITH THE TRACK ─────────────────────────
 * Coupling is measured by playing a short pink-noise burst, because it excites
 * every band evenly. Measuring it from the music instead would divide by
 * near-zero in whichever bands the track happens to be quiet in at that
 * moment, and produce a wild coefficient that then over-subtracts for the rest
 * of the session.
 *
 * ── AND MEASURED AS A SLOPE, NOT A RATIO. FOUND BY TESTING, 2026-10-09 ─────
 * The first version computed c = (heard - room) / played per frame and took
 * the median. Driven in a headless browser — where there is NO acoustic path
 * whatsoever, because the fake microphone reads a file — it confidently
 * reported 32 dB of speaker leak, because the burst happened to overlap a loud
 * passage in the fake microphone's file and the estimator had no way to tell
 * "the speaker did this" from "something else did this at the same time".
 *
 * On a phone that is not a curiosity, it is the failure mode: anybody who
 * breathes, speaks or closes a door during the one-second burst inflates the
 * coefficient, and the detector then over-subtracts for the entire session and
 * silently disarms itself. A median survives ONE transient; it does not
 * survive a sustained one.
 *
 * So the pink level is MODULATED during the burst and coupling is the
 * least-squares SLOPE of heard against played:
 *
 *     heard_b = intercept_b + c_b * played_b
 *
 * Anything not correlated with the speaker — the room, a breath, a voice —
 * lands in `intercept_b` and leaves the slope alone. That is the whole point:
 * it measures what the speaker CAUSES rather than what merely coincides
 * with it. `confidence` reports how well the line actually fit, so a
 * measurement taken through a sound nobody controlled is visible rather than
 * trusted.
 *
 * Everything here is linear POWER, never dB, because power is what adds.
 */

/** One frame of the coupling measurement: what we played, what came back. */
export type CouplingSample = {
  /** Band powers measured on the PLAYBACK analyser, post-volume. */
  readonly played: readonly [number, number, number];
  /** Band powers measured on the MICROPHONE analyser. */
  readonly heard: readonly [number, number, number];
  /** Broadband power, same two taps. */
  readonly playedRms: number;
  readonly heardRms: number;
};

/**
 * The transfer from speaker to microphone, per band.
 *
 * Volume-independent by construction: the playback analyser is tapped AFTER
 * the volume gain, so a volume change moves `played` and leaves these alone.
 * That is the whole reason the analyser sits where it does.
 */
export type Coupling = {
  readonly band: readonly [number, number, number];
  readonly rms: number;
  /** Leak over the room floor at the loudest measured level, in dB. */
  readonly leakDb: number;
  readonly framesUsed: number;
  /**
   * Pearson r-squared of the heard-against-played fit, worst of the three
   * bands. Near 1 means the speaker explains what came back. Low means
   * something uncorrelated was happening and these numbers are not evidence.
   */
  readonly confidence: number;
};

/** Below this, the fit is not trustworthy and subtraction should be skipped. */
export const MIN_CONFIDENCE = 0.5;

/** Guard against a band the speaker never reached. */
const MIN_PLAYED_POWER = 1e-12;

/**
 * Coupling from paired frames, given the already-measured room floor.
 *
 *   heard = room + c * played        (linear power, per band)
 *   c     = (heard - room) / played
 *
 * Median rather than mean, for the reason the room floor uses one: a cough
 * during the burst must not permanently inflate a coefficient.
 */
/**
 * Note what is NOT a parameter any more: the room floor.
 *
 * A slope does not need it. Whatever the room contributes is constant across
 * the burst, so it lands in the intercept and never touches `c_b`. The ratio
 * version had to subtract it explicitly and was wrong whenever the estimate of
 * it was stale. `roomRms` is still taken, but only to express the result in dB
 * over the floor for a human to read.
 */
export function estimateCoupling(
  samples: readonly CouplingSample[],
  roomRms: number,
): Coupling {
  if (samples.length < 8) {
    return {
      band: [0, 0, 0], rms: 0, leakDb: Number.NEGATIVE_INFINITY,
      framesUsed: samples.length, confidence: 0,
    };
  }

  /** Least-squares slope of y on x, plus how well the line fit. */
  const fit = (xs: number[], ys: number[]): { slope: number; r2: number } => {
    const n = xs.length;
    if (n < 8) return { slope: 0, r2: 0 };
    const mx = xs.reduce((a, v) => a + v, 0) / n;
    const my = ys.reduce((a, v) => a + v, 0) / n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i += 1) {
      const dx = xs[i] - mx;
      const dy = ys[i] - my;
      sxy += dx * dy;
      sxx += dx * dx;
      syy += dy * dy;
    }
    /* The level never moved, so nothing can be attributed to the speaker. */
    if (sxx <= MIN_PLAYED_POWER * MIN_PLAYED_POWER) return { slope: 0, r2: 0 };
    const slope = sxy / sxx;
    const r2 = syy <= 0 ? 0 : (sxy * sxy) / (sxx * syy);
    /* A negative slope means louder playback came with a quieter microphone,
       which is physically meaningless and would ADD energy on subtraction. */
    return { slope: Math.max(0, slope), r2 };
  };

  const perBand: [number, number, number] = [0, 0, 0];
  let worstR2 = 1;
  for (let b = 0; b < 3; b += 1) {
    const { slope, r2 } = fit(
      samples.map((s) => s.played[b]),
      samples.map((s) => s.heard[b]),
    );
    perBand[b] = slope;
    worstR2 = Math.min(worstR2, r2);
  }

  const rmsFit = fit(samples.map((s) => s.playedRms), samples.map((s) => s.heardRms));

  /* Reported at the loudest level actually played, which is the worst case
     the subtraction will be asked to handle. */
  const loudest = samples.reduce((a, s) => Math.max(a, s.playedRms), 0);
  const predicted = rmsFit.slope * loudest;
  const leakDb =
    predicted <= 0 || roomRms <= 0
      ? Number.NEGATIVE_INFINITY
      : 10 * Math.log10(predicted / roomRms);

  return {
    band: perBand,
    rms: rmsFit.slope,
    leakDb,
    framesUsed: samples.length,
    confidence: Math.max(0, Math.min(1, worstR2)),
  };
}

/**
 * Leak above which subtraction stops being able to rescue a breath.
 *
 * GUESS, and it wants a phone. The reasoning: a close exhale is expected
 * 25–40 dB over the room floor, and the residual left behind by an imperfect
 * subtraction grows with the leak it is removing. Past about 20 dB of leak the
 * residual starts to reach the onset threshold on its own.
 */
export const LEAK_WARN_DB = 20;

/** Past this, the track is simply louder than anything a person can do. */
export const LEAK_FATAL_DB = 35;

/**
 * The floor to subtract RIGHT NOW: the room, plus what the track predicts.
 *
 * Takes the playback band powers as they were `lag` ago rather than as they
 * are, because the microphone is hearing the past — see the ring buffer in
 * useBreathDetector. A mis-estimated lag mostly costs accuracy during
 * transients, where the playback spectrum is changing fastest.
 */
export function dynamicFloor(
  roomBand: readonly [number, number, number],
  roomRms: number,
  coupling: Coupling | null,
  playedDelayed: readonly [number, number, number] | null,
  playedRmsDelayed: number,
): { band: [number, number, number]; rmsDb: number } {
  if (coupling === null || playedDelayed === null) {
    return {
      band: [roomBand[0], roomBand[1], roomBand[2]],
      rmsDb: 10 * Math.log10(Math.max(roomRms, 1e-20)),
    };
  }
  return {
    band: [
      roomBand[0] + coupling.band[0] * playedDelayed[0],
      roomBand[1] + coupling.band[1] * playedDelayed[1],
      roomBand[2] + coupling.band[2] * playedDelayed[2],
    ],
    rmsDb:
      10 * Math.log10(Math.max(roomRms + coupling.rms * playedRmsDelayed, 1e-20)),
  };
}
