import { FFT_SIZE, SMOOTHING_TIME_CONSTANT } from '../detect/config';

/**
 * What the phone plays, and a tap to measure it with.
 *
 * ── THE ANALYSER SITS AFTER THE VOLUME GAIN, AND THAT IS THE DESIGN ────────
 *
 *     source -> volume -> analyser -> destination
 *
 * Coupling coefficients are then VOLUME-INDEPENDENT: turning the track down
 * moves what the analyser reports, so the measured speaker-to-microphone
 * transfer stays valid and nothing has to be recalibrated. Tapping before the
 * gain instead would make every coefficient wrong the moment anybody touched
 * the volume slider.
 *
 * There is deliberately NO test signal here any more. Coupling used to be
 * measured with a level-stepped pink-noise burst, which worked and sounded
 * like a stuttering "krrr krrr" before a calm breathing exercise. The
 * regression that estimates coupling only needs the playback level to VARY,
 * and music varies more than any burst does — so the track is its own
 * excitation and the measurement is silent. See detect/coupling.ts.
 */

export type Playback = {
  /** Tapped post-volume. Its band powers are what coupling multiplies. */
  readonly analyser: AnalyserNode;
  readonly setVolume: (v: number) => void;
  readonly playTrack: () => Promise<void>;
  readonly pauseTrack: () => void;
  readonly loadFile: (file: File) => void;
  readonly useGeneratedPad: () => void;
  readonly state: () => { source: 'none' | 'file' | 'pad'; playing: boolean; name: string };
  readonly dispose: () => void;
};

/**
 * A slow ambient pad, so the spike runs with no asset at all.
 *
 * Deliberately NOT music: a few detuned partials with slow amplitude drift.
 * It is here so the track path can be exercised before anybody has found an
 * mp3, and it is the wrong signal for judging whether this works on real
 * music — a real mix is far denser and leaks far more.
 *
 * It SWELLS, and that is functional rather than decorative. The leak estimate
 * is a regression against the playback level, so a track whose level never
 * moves cannot be measured at all. A flat drone here would make the very
 * first thing anybody tries report an unmeasurable leak.
 */
function padBuffer(context: AudioContext, seconds: number): AudioBuffer {
  const sr = context.sampleRate;
  const n = Math.floor(sr * seconds);
  const buffer = context.createBuffer(1, n, sr);
  const out = buffer.getChannelData(0);
  const partials = [110, 164.81, 220, 277.18, 329.63, 440];
  for (let i = 0; i < n; i += 1) {
    const t = i / sr;
    let v = 0;
    partials.forEach((f, k) => {
      const drift = 0.5 + 0.5 * Math.sin(2 * Math.PI * (0.03 + k * 0.011) * t + k);
      v += (drift / (k + 1.6)) * Math.sin(2 * Math.PI * f * t + k * 1.3);
    });
    /* A long fade at both ends so the loop point is inaudible. */
    const fade = Math.min(1, t / 2, (seconds - t) / 2);
    /* Two slow swells over the loop, deep enough to fit a slope against. */
    const swell = 0.35 + 0.65 * (0.5 - 0.5 * Math.cos(2 * Math.PI * t / (seconds / 2)));
    out[i] = v * 0.22 * swell * Math.max(0, fade);
  }
  return buffer;
}

export function createPlayback(context: AudioContext): Playback {
  const volume = context.createGain();
  volume.gain.value = 0.6;

  const analyser = context.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = SMOOTHING_TIME_CONSTANT;

  volume.connect(analyser).connect(context.destination);

  const element = new Audio();
  element.loop = true;
  element.crossOrigin = 'anonymous';
  /* A MediaElementAudioSourceNode may only be created once per element, so it
     is created here and the element's src is swapped underneath it. */
  const elementSource = context.createMediaElementSource(element);
  elementSource.connect(volume);

  let pad: AudioBufferSourceNode | null = null;
  let padCache: AudioBuffer | null = null;
  let source: 'none' | 'file' | 'pad' = 'none';
  let name = '';
  let objectUrl: string | null = null;

  const stopPad = () => {
    if (pad === null) return;
    try { pad.stop(); } catch { /* already stopped */ }
    pad.disconnect();
    pad = null;
  };

  return {
    analyser,

    setVolume: (v) => {
      /* setTargetAtTime rather than a jump: a step change in gain is an audible
         click, and a click is a broadband transient straight into the mic. */
      volume.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), context.currentTime, 0.02);
    },

    playTrack: async () => {
      if (source === 'pad') {
        stopPad();
        if (padCache === null) padCache = padBuffer(context, 24);
        pad = context.createBufferSource();
        pad.buffer = padCache;
        pad.loop = true;
        pad.connect(volume);
        pad.start();
        return;
      }
      if (source === 'file') await element.play();
    },

    pauseTrack: () => {
      /**
       * Explicit, and this is musie's §3.2 first domino.
       *
       * Its listen step never paused its own <audio> element on the way out
       * and relied on React detaching it. That normally works, but it leaves
       * the iOS audio session held by garbage collection timing, and this is
       * the one place where releasing it deterministically is nearly free.
       */
      element.pause();
      stopPad();
    },

    loadFile: (file) => {
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(file);
      element.src = objectUrl;
      source = 'file';
      name = file.name;
    },

    useGeneratedPad: () => {
      element.pause();
      element.removeAttribute('src');
      source = 'pad';
      name = 'generated pad';
    },

    state: () => ({
      source,
      playing: source === 'pad' ? pad !== null : !element.paused && element.src !== '',
      name,
    }),

    dispose: () => {
      element.pause();
      element.removeAttribute('src');
      stopPad();
      elementSource.disconnect();
      volume.disconnect();
      analyser.disconnect();
      if (objectUrl !== null) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    },
  };
}
