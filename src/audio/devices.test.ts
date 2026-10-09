import { describe, expect, it } from 'vitest';
import { classify, preferBuiltIn, routeFromRate } from './devices';

describe('classify', () => {
  it('recognises the labels iOS actually uses for a headset', () => {
    expect(classify('Headset Microphone (AirPods Pro)')).toBe('headset');
    expect(classify('AirPods Max')).toBe('headset');
    expect(classify('Kopfhörer-Mikrofon')).toBe('headset');
  });

  it('recognises the phone itself', () => {
    expect(classify('iPhone Microphone')).toBe('builtIn');
    expect(classify('Bottom Microphone')).toBe('builtIn');
    expect(classify('Default')).toBe('builtIn');
  });

  /** Before permission every label is '' — that must not read as built-in. */
  it('refuses to guess from an empty label', () => {
    expect(classify('')).toBe('unknown');
  });

  it('prefers headset when a label says both', () => {
    /* "iPhone" appears in plenty of headset labels, and getting this backwards
       would silently select the narrowband route. */
    expect(classify('AirPods Pro – iPhone')).toBe('headset');
  });
});

describe('preferBuiltIn', () => {
  it('returns nothing rather than guessing when none is identifiable', () => {
    expect(preferBuiltIn([{ deviceId: 'a', label: '', kind: 'unknown' }])).toBeNull();
  });

  it('finds the built-in one among several', () => {
    const found = preferBuiltIn([
      { deviceId: 'h', label: 'AirPods', kind: 'headset' },
      { deviceId: 'b', label: 'iPhone Microphone', kind: 'builtIn' },
    ]);
    expect(found?.deviceId).toBe('b');
  });
});

describe('routeFromRate', () => {
  /**
   * The strongest tell available: HFP cannot carry more than 16 kHz, so this
   * identifies a Bluetooth headset mic whatever the device labels claim.
   */
  it('reads a narrowband rate as a headset route', () => {
    expect(routeFromRate(8000)).toEqual({ likely: 'headset', narrowband: true });
    expect(routeFromRate(16000)).toEqual({ likely: 'headset', narrowband: true });
  });

  it('reads a full rate as the built-in route', () => {
    expect(routeFromRate(48000).narrowband).toBe(false);
    expect(routeFromRate(48000).likely).toBe('builtIn');
  });

  /** 24 kHz is wideband-ish but still has no 4-8 kHz band to speak of. */
  it('flags the awkward middle as narrowband without claiming a route', () => {
    expect(routeFromRate(24000)).toEqual({ likely: 'unknown', narrowband: true });
  });
});
