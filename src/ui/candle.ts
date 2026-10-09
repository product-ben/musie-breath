/**
 * The flame's life, as a pure state machine.
 *
 * No WebGL, no canvas, no clock — `dtMs` is a parameter. The renderer only
 * uploads what this returns as uniforms, which is the same split the detector
 * uses: anything that can be WRONG lives where a test can drive it with
 * fixture values, and the part that can only be LOOKED AT stays in the
 * component.
 *
 * Three regimes, because that is what a candle does: it burns, it dances when
 * you breathe at it, and it goes out when you overdo it.
 */

export type CandlePhase = 'lit' | 'out' | 'relighting';

export type CandleState = {
  readonly phase: CandlePhase;
  /** 0..1. How much flame there is. Drives height and opacity. */
  readonly life: number;
  /** 0..1. How hard the flame is pushed over. */
  readonly lean: number;
  /** 0..1. How violently it churns. */
  readonly turbulence: number;
  /** 0..1. Smoke rising after a blowout; outlives the flame. */
  readonly smoke: number;
  /** 0..1. A brief flare as it catches again. */
  readonly flare: number;
  readonly phaseMs: number;
  readonly blowouts: number;
};

export type CandleConfig = {
  /**
   * Peak sample level counted as overdriven. 1.0 is the top of the converter's
   * range, so at or above this the waveform is being flattened.
   */
  readonly clipPeak: number;
  /** Intensity that blows it out even without hard clipping. */
  readonly blowoutIntensity: number;
  /** How long overdrive must hold, so one click cannot do it. */
  readonly blowoutHoldMs: number;
  readonly relightDelayMs: number;
  /** It will not catch again while you are still breathing at it. */
  readonly relightCalmIntensity: number;
  readonly extinguishTauMs: number;
  readonly relightTauMs: number;
  readonly smokeTauMs: number;
  readonly leanTauMs: number;
};

export const DEFAULT_CANDLE: CandleConfig = {
  clipPeak: 0.985,
  blowoutIntensity: 0.88,
  /**
   * 70 ms is two to four frames: long enough that a tap on the case or one
   * stray clipped sample cannot put the flame out, short enough that blowing
   * it out still feels instant to the person doing it. A flame that dies at
   * random is not feedback, it is noise.
   */
  blowoutHoldMs: 70,
  relightDelayMs: 1400,
  relightCalmIntensity: 0.18,
  extinguishTauMs: 90,
  relightTauMs: 220,
  smokeTauMs: 900,
  /**
   * Faster than the detector's own release, because air moves faster than an
   * envelope does: the flame should answer the gust, not the measurement.
   */
  leanTauMs: 110,
};

export function initialCandle(): CandleState {
  return {
    phase: 'lit', life: 1, lean: 0, turbulence: 0, smoke: 0, flare: 0,
    phaseMs: 0, blowouts: 0,
  };
}

/** One-pole step towards a target, from dt, so 120 Hz matches 60 Hz. */
function approach(current: number, target: number, tauMs: number, dtMs: number): number {
  if (tauMs <= 0) return target;
  return current + (1 - Math.exp(-dtMs / tauMs)) * (target - current);
}

/** Genuinely overdriven, rather than merely loud. */
export function isOverdriven(
  frame: { intensity: number; peak: number },
  config: CandleConfig,
): boolean {
  return frame.peak >= config.clipPeak || frame.intensity >= config.blowoutIntensity;
}

export function nextCandle(
  prev: CandleState,
  frame: { intensity: number; peak: number },
  dtMs: number,
  config: CandleConfig,
  /** How long overdrive has held, in ms. Carried by the caller. */
  overdrivenForMs: number,
): CandleState {
  const phaseMs = prev.phaseMs + dtMs;
  const smoke = approach(prev.smoke, 0, config.smokeTauMs, dtMs);
  const blownOut = isOverdriven(frame, config) && overdrivenForMs >= config.blowoutHoldMs;

  switch (prev.phase) {
    case 'lit': {
      if (blownOut) {
        return {
          ...prev,
          phase: 'out',
          phaseMs: 0,
          /* Smoke starts full and outlives the flame, which is what makes a
             blowout read as an event rather than as a fade. */
          smoke: 1,
          flare: 0,
          blowouts: prev.blowouts + 1,
        };
      }
      const target = Math.max(0, Math.min(1, frame.intensity));
      return {
        ...prev,
        phase: 'lit',
        phaseMs,
        life: approach(prev.life, 1, config.relightTauMs, dtMs),
        lean: approach(prev.lean, target, config.leanTauMs, dtMs),
        turbulence: approach(prev.turbulence, target, config.leanTauMs * 1.6, dtMs),
        smoke,
        flare: approach(prev.flare, 0, 180, dtMs),
      };
    }

    case 'out': {
      const life = approach(prev.life, 0, config.extinguishTauMs, dtMs);
      const calm = frame.intensity <= config.relightCalmIntensity;
      /* It will not relight into a wind that is still blowing. */
      if (phaseMs >= config.relightDelayMs && calm && !isOverdriven(frame, config)) {
        return { ...prev, phase: 'relighting', phaseMs: 0, life, smoke, flare: 1 };
      }
      return {
        ...prev,
        phase: 'out',
        phaseMs,
        life,
        lean: approach(prev.lean, 0, config.leanTauMs, dtMs),
        turbulence: approach(prev.turbulence, 0, config.leanTauMs, dtMs),
        smoke,
        flare: 0,
      };
    }

    case 'relighting': {
      const life = approach(prev.life, 1, config.relightTauMs, dtMs);
      /* Breathing at it during the catch puts it straight back out. */
      if (blownOut) {
        return {
          ...prev, phase: 'out', phaseMs: 0, life,
          smoke: 1, flare: 0, blowouts: prev.blowouts + 1,
        };
      }
      if (life > 0.97) {
        return {
          ...prev, phase: 'lit', phaseMs: 0, life: 1, smoke,
          flare: approach(prev.flare, 0, 180, dtMs),
        };
      }
      return {
        ...prev,
        phase: 'relighting',
        phaseMs,
        life,
        lean: approach(prev.lean, 0, config.leanTauMs, dtMs),
        turbulence: approach(prev.turbulence, 0.25, config.leanTauMs, dtMs),
        smoke,
        flare: approach(prev.flare, 0, 300, dtMs),
      };
    }
  }
}
