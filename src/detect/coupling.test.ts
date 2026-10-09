import { describe, expect, it } from 'vitest';
import { MIN_CONFIDENCE, dynamicFloor, estimateCoupling } from './coupling';
import type { CouplingSample } from './coupling';

const ROOM: [number, number, number] = [1e-8, 1e-8, 1e-8];
const ROOM_RMS = 3e-8;

/** The three levels the burst actually steps through. */
const LEVELS = [1, 0.35, 0.12];

/**
 * A burst of frames at stepped levels, with a known coupling.
 *
 * `extra` is sound the speaker did NOT cause — a breath, a voice, a door —
 * which is the thing the slope has to be immune to.
 */
function burst(c: number, frames = 54, extra: (i: number) => number = () => 0): CouplingSample[] {
  return Array.from({ length: frames }, (_, i) => {
    const level = LEVELS[Math.floor(i / 6) % LEVELS.length];
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
  it('recovers a known coupling from a stepped burst', () => {
    const c = estimateCoupling(burst(0.02), ROOM_RMS);
    expect(c.band[0]).toBeCloseTo(0.02, 5);
    expect(c.rms).toBeCloseTo(0.02, 5);
    expect(c.confidence).toBeGreaterThan(0.99);
  });

  /** Headphones: nothing comes back, so nothing must be subtracted later. */
  it('reports zero coupling when the speaker never reaches the mic', () => {
    const c = estimateCoupling(burst(0), ROOM_RMS);
    expect(c.band[0]).toBeCloseTo(0, 9);
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
