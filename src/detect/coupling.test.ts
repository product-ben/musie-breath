import { describe, expect, it } from 'vitest';
import { MIN_CONFIDENCE, MIN_DRIVE, MIN_LEAK_FRAMES, dynamicFloor, estimateCoupling, leakVerdict } from './coupling';
import type { CouplingSample } from './coupling';

const ROOM: [number, number, number] = [1e-8, 1e-8, 1e-8];
const ROOM_RMS = 3e-8;

/**
 * Frames of a TRACK PLAYING, with a known coupling.
 *
 * The level follows a music-like contour rather than a stepped burst, because
 * that is what the estimator is now fed: there is no test signal any more, the
 * track's own dynamics are the excitation.
 *
 * `extra` is sound the speaker did NOT cause — a breath, a voice, a door —
 * which is the thing the slope has to be immune to.
 */
function burst(c: number, frames = 54, extra: (i: number) => number = () => 0): CouplingSample[] {
  return Array.from({ length: frames }, (_, i) => {
    /* A slow swell with beats on top: roughly how a mix's level moves. */
    const level =
      0.45 + 0.4 * Math.sin(i / 9) + (i % 7 === 0 ? 0.15 : 0);
    const played = 1e-4 * level * level;
    const uncorrelated = extra(i);
    return {
      played: [played, played, played],
      heard: [
        ROOM[0] + c * played + uncorrelated,
        ROOM[1] + c * played + uncorrelated,
        ROOM[2] + c * played + uncorrelated,
      ],
      playedRms: played * 3,
      heardRms: ROOM_RMS + c * played * 3 + uncorrelated * 3,
    };
  });
}

describe('estimateCoupling', () => {
  it("recovers a known coupling from the track's own dynamics", () => {
    const c = estimateCoupling(burst(0.02), ROOM_RMS);
    expect(c.band[0]).toBeCloseTo(0.02, 5);
    expect(c.rms).toBeCloseTo(0.02, 5);
    expect(c.confidence).toBeGreaterThan(0.99);
  });

  /**
   * Headphones: nothing comes back, so nothing must be subtracted later.
   *
   * A least-squares slope over smoothly varying playback does not land on
   * exactly zero even with no acoustic path — it lands on about 1e-30, whose
   * log is -300 dB. That has to be reported as "none" rather than as a
   * number, which is what NEGLIGIBLE_LEAK_DB is for.
   */
  it('reports no leak at all when the speaker never reaches the mic', () => {
    const c = estimateCoupling(burst(0), ROOM_RMS);
    expect(c.band[0]).toBeCloseTo(0, 9);
    expect(c.leakDb).toBe(Number.NEGATIVE_INFINITY);
  });

  it('calls a leak far below the room floor none, rather than a big negative', () => {
    const c = estimateCoupling(burst(1e-9), ROOM_RMS);
    expect(c.leakDb).toBe(Number.NEGATIVE_INFINITY);
  });

  /**
   * THE BUG THIS FILE WAS REWRITTEN FOR.
   *
   * Driven in a headless browser, where there is no acoustic path at all, the
   * ratio-and-median version reported 32 dB of speaker leak — because the
   * burst coincided with a loud passage in the fake microphone's file. On a
   * phone the same thing happens whenever somebody breathes or talks during
   * the burst, and the detector then over-subtracts for the whole session.
   *
   * A SUSTAINED uncorrelated sound, which no median can reject, must leave the
   * slope untouched.
   */
  it('is immune to a loud sound that merely coincides with the burst', () => {
    /* Fifty times the room power, present in EVERY frame of the burst. */
    const c = estimateCoupling(burst(0.02, 54, () => ROOM[0] * 50), ROOM_RMS);
    expect(c.band[0]).toBeCloseTo(0.02, 5);
    expect(c.rms).toBeCloseTo(0.02, 5);
  });

  it('still recovers the slope through a sound that drifts during the burst', () => {
    const c = estimateCoupling(burst(0.02, 54, (i) => ROOM[0] * (10 + i)), ROOM_RMS);
    /* Not exact — a drift correlates a little with the level pattern — but
       nowhere near the order-of-magnitude error the ratio version made. */
    expect(c.band[0]).toBeGreaterThan(0.012);
    expect(c.band[0]).toBeLessThan(0.030);
  });

  /** A measurement taken through chaos must announce itself as one. */
  it('reports low confidence when nothing explains what came back', () => {
    const noisy = burst(0.02, 54, (i) => ROOM[0] * 400 * (1 + Math.sin(i * 2.7)));
    expect(estimateCoupling(noisy, ROOM_RMS).confidence).toBeLessThan(MIN_CONFIDENCE);
  });

  /** A drone with no dynamics gives the regression nothing to work with. */
  it('refuses to guess when the level never moved', () => {
    const flat: CouplingSample[] = Array.from({ length: 54 }, () => ({
      played: [1e-4, 1e-4, 1e-4] as const,
      heard: [2e-6, 2e-6, 2e-6] as const,
      playedRms: 3e-4,
      heardRms: 6e-6,
    }));
    const c = estimateCoupling(flat, ROOM_RMS);
    expect(c.band[0]).toBe(0);
    expect(c.confidence).toBe(0);
  });

  it('never returns a negative coefficient', () => {
    /* Louder playback with a quieter mic is physically meaningless, and would
       ADD energy when subtracted. */
    const inverted = burst(-0.02);
    expect(estimateCoupling(inverted, ROOM_RMS).band.every((v) => v >= 0)).toBe(true);
  });

  /**
   * THE ONE WAY THIS CAN STILL BE FOOLED, documented rather than hidden.
   *
   * A breath is normally uncorrelated with the music and lands in the
   * intercept. But in a guided breathing exercise people breathe IN TIME with
   * the track, and a breath that rises and falls WITH the level biases the
   * slope upward — which would over-subtract and disarm the detector.
   *
   * This is why the leak phase in useBreathDetector excludes frames where a
   * breath looks to be in progress. This test exists so that the exclusion is
   * never quietly removed as redundant.
   */
  it('IS biased by interference correlated with the level', () => {
    const synced = burst(0.02, 54, (i) => {
      const level = 0.45 + 0.4 * Math.sin(i / 9);
      return 1e-4 * level * level * 0.05; // a breath in time with the music
    });
    const c = estimateCoupling(synced, ROOM_RMS);
    /* Materially above the true 0.02 — the fit still looks excellent, which
       is exactly what makes it dangerous. */
    expect(c.band[0]).toBeGreaterThan(0.03);
    expect(c.confidence).toBeGreaterThan(0.9);
  });

  it('declines to report anything from too few frames', () => {
    const c = estimateCoupling(burst(0.02, 4), ROOM_RMS);
    expect(c.confidence).toBe(0);
    expect(c.band[0]).toBe(0);
  });
});

describe('dynamicFloor', () => {
  it('is exactly the room floor when nothing is playing', () => {
    const f = dynamicFloor(ROOM, ROOM_RMS, null, null, 0);
    expect(f.band[0]).toBe(ROOM[0]);
    expect(f.rmsDb).toBeCloseTo(10 * Math.log10(ROOM_RMS), 6);
  });

  /**
   * The point of the whole file: a frame containing ONLY the leaked track must
   * come out at zero excess, so the detector never sees the music as a breath.
   */
  it('cancels a frame that is nothing but leaked track', () => {
    const c = estimateCoupling(burst(0.02), ROOM_RMS);
    const played = 1e-4;
    const f = dynamicFloor(ROOM, ROOM_RMS, c, [played, played, played], played * 3);

    const heardBand = ROOM[0] + 0.02 * played;
    expect(Math.max(0, heardBand - f.band[0])).toBeCloseTo(0, 11);

    const heardRmsDb = 10 * Math.log10(ROOM_RMS + 0.02 * played * 3);
    expect(heardRmsDb - f.rmsDb).toBeCloseTo(0, 5);
  });

  /** And a real breath on top of the track must still clear the raised floor. */
  it('leaves a breath above the raised floor', () => {
    const c = estimateCoupling(burst(0.02), ROOM_RMS);
    const played = 1e-4;
    const f = dynamicFloor(ROOM, ROOM_RMS, c, [played, played, played], played * 3);

    /* A breath 30 dB over the room floor, arriving on top of the leak. */
    const breathPower = ROOM_RMS * 1000;
    const heardRmsDb = 10 * Math.log10(ROOM_RMS + 0.02 * played * 3 + breathPower);
    expect(heardRmsDb - f.rmsDb).toBeGreaterThan(6);
  });
});

describe('drive', () => {
  /**
   * The two facts that used to arrive as one. A poor fit on a drone can never
   * improve, so the caller must not sit waiting for it; a poor fit on a track
   * that IS moving might.
   */
  it('is near zero for a drone and substantial for a dynamic track', () => {
    const drone: CouplingSample[] = Array.from({ length: 54 }, () => ({
      played: [1e-4, 1e-4, 1e-4] as const,
      heard: [2e-6, 2e-6, 2e-6] as const,
      playedRms: 3e-4,
      heardRms: 6e-6,
    }));
    expect(estimateCoupling(drone, ROOM_RMS).drive).toBeLessThan(MIN_DRIVE);
    expect(estimateCoupling(burst(0.02), ROOM_RMS).drive).toBeGreaterThan(MIN_DRIVE);
  });
});

describe('leakVerdict', () => {
  /**
   * THE HEADPHONE CASE, and the one this classification was added for.
   *
   * With headphones the speaker genuinely does not reach the microphone, so
   * the slope is ~0 and r-squared is meaningless — there is no relationship to
   * fit. Reading that as a failed measurement made the configuration the whole
   * exercise is for wait nine seconds for a fit that could never succeed and
   * then apologise. It is the GOOD outcome and must classify as one.
   */
  it('calls a negligible slope none, whatever the fit says', () => {
    const c = estimateCoupling(burst(0), ROOM_RMS);
    expect(c.confidence).toBeLessThan(MIN_CONFIDENCE);
    expect(leakVerdict(c)).toBe('none');
  });

  it('calls a well-fitted real leak measured', () => {
    expect(leakVerdict(estimateCoupling(burst(0.02), ROOM_RMS))).toBe('measured');
  });

  it('calls a drone unmeasurable rather than leak-free', () => {
    const drone: CouplingSample[] = Array.from({ length: 54 }, () => ({
      played: [1e-4, 1e-4, 1e-4] as const,
      heard: [2e-6, 2e-6, 2e-6] as const,
      playedRms: 3e-4, heardRms: 6e-6,
    }));
    expect(leakVerdict(estimateCoupling(drone, ROOM_RMS))).toBe('unmeasurable');
  });

  it('calls a real leak with a bad fit untrusted', () => {
    const noisy = burst(0.02, 54, (i) => ROOM[0] * 400 * (1 + Math.sin(i * 2.7)));
    expect(leakVerdict(estimateCoupling(noisy, ROOM_RMS))).toBe('untrusted');
  });

  it('treats a missing measurement as unmeasurable, never as leak-free', () => {
    expect(leakVerdict(null)).toBe('unmeasurable');
  });
});

describe('MIN_LEAK_FRAMES', () => {
  /**
   * The caller discards every frame with a breath in it, so somebody
   * breathing steadily can leave only a handful behind. Eight frames is enough
   * to COMPUTE a slope and nowhere near enough to trust one, which is why the
   * caller waits for more rather than concluding from nine.
   */
  it('is well above the hard floor needed to compute a slope at all', () => {
    expect(MIN_LEAK_FRAMES).toBeGreaterThan(8);
  });

  it('still produces a usable verdict once there are enough frames', () => {
    const c = estimateCoupling(burst(0.02, MIN_LEAK_FRAMES), ROOM_RMS);
    expect(c.framesUsed).toBe(MIN_LEAK_FRAMES);
    expect(leakVerdict(c)).toBe('measured');
  });
});
