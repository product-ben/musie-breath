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
 * Pink noise for the coupling burst goes through the SAME gain and the SAME
 * analyser, so the burst is measured on exactly the path the music will take.
 */

export type Playback = {
  /** Tapped post-volume. Its band powers are what coupling multiplies. */
  readonly analyser: AnalyserNode;
  readonly setVolume: (v: number) => void;
  /** Pink noise through the same path, for the coupling measurement. */
  readonly startPink: () => void;
  /**
   * The burst's own level, stepped during the measurement so the regression
   * in detect/coupling.ts has a slope to fit. Separate from the user's volume
   * so stepping it does not move the slider under them.
   */
  readonly setPinkLevel: (level: number) => void;
  readonly stopPink: () => void;
  readonly playTrack: () => Promise<void>;
  readonly pauseTrack: () => void;
  readonly loadFile: (file: File) => void;
  readonly useGeneratedPad: () => void;
  readonly state: () => { source: 'none' | 'file' | 'pad'; playing: boolean; name: string };
  readonly dispose: () => void;
};

/**
 * Pink noise, Paul Kellett's filter on white noise.
 *
 * Pink rather than white because the coupling estimate wants roughly equal
 * energy per octave: white noise puts most of its power in the top octave,
 * where a phone speaker is least able to reproduce it, so the low-band
 * coefficient would be measured from almost nothing.
 */
function pinkBuffer(context: AudioContext, seconds: number): AudioBuffer {
  const n = Math.floor(context.sampleRate * seconds);
  const buffer = context.createBuffer(1, n, context.sampleRate);
  const out = buffer.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i += 1) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return buffer;
}

/**
 * A slow ambient pad, so the spike runs with no asset at all.
 *
 * Deliberately NOT music: a few detuned partials with slow amplitude drift.
 * It is here so the track path can be exercised before anybody has found an
 * mp3, and it is the wrong signal for judging whether this works on real
 * music — a real mix is far denser and leaks far more.
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
    out[i] = v * 0.16 * Math.max(0, fade);
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

  const pinkGain = context.createGain();
  pinkGain.gain.value = 1;
  pinkGain.connect(volume);

  let pink: AudioBufferSourceNode | null = null;
  let pad: AudioBufferSourceNode | null = null;
  let pinkCache: AudioBuffer | null = null;
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

    startPink: () => {
      if (pinkCache === null) pinkCache = pinkBuffer(context, 2);
      pink = context.createBufferSource();
      pink.buffer = pinkCache;
      pink.loop = true;
      pinkGain.gain.value = 1;
      pink.connect(pinkGain);
      pink.start();
    },

    setPinkLevel: (level) => {
      pinkGain.gain.setTargetAtTime(
        Math.max(0, Math.min(1, level)), context.currentTime, 0.01,
      );
    },

    stopPink: () => {
      if (pink === null) return;
      try { pink.stop(); } catch { /* already stopped */ }
      pink.disconnect();
      pink = null;
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
      if (pink !== null) { try { pink.stop(); } catch { /* ignore */ } pink.disconnect(); pink = null; }
      elementSource.disconnect();
      pinkGain.disconnect();
      volume.disconnect();
      analyser.disconnect();
      if (objectUrl !== null) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    },
  };
}
