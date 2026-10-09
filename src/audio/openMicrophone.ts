import { FFT_SIZE, SMOOTHING_TIME_CONSTANT } from '../detect/config';
import type { CaptureFailure } from '../detect/status';

/**
 * The ONLY effectful file in this spike. Everything else is pure.
 *
 * Adapted from musie's features/voice/src/audio/recorder.ts, keeping its
 * discipline — one teardown with three callers, a code rather than a sentence
 * on every failure, capture proven by data rather than by state — and dropping
 * everything about PCM, base64 and sockets.
 *
 * The ordering below is not stylistic. Each step's position was established by
 * measurement in musie's docs/VOICE-CAPTURE-FIX.md §2, and the comments say
 * which.
 */

export class MicrophoneError extends Error {
  readonly code: CaptureFailure;

  constructor(code: CaptureFailure) {
    super(code);
    this.name = 'MicrophoneError';
    this.code = code;
  }
}

/** The three constraints this spike exists to measure. */
export type Processing = {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
};

/**
 * ALL THREE OFF BY DEFAULT, and this is a measurement decision rather than a
 * preference.
 *
 * Every one of them is tuned for speech intelligibility, and two of them
 * modify exactly the quantities being measured here:
 *
 *  - noiseSuppression is designed to classify non-speech as noise and discard
 *    it. Breath is not speech.
 *  - autoGainControl MOVES THE NOISE FLOOR AFTER WE HAVE MEASURED IT, which is
 *    directly hostile to a design whose every threshold is relative to a
 *    calibrated floor.
 *
 * Starting them on would mean the spike's first measurement is of a processed
 * signal with an unknown transfer function.
 */
export const DEFAULT_PROCESSING: Processing = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

export type Microphone = {
  readonly analyser: AnalyserNode;
  /**
   * Shared on purpose. Playback goes through THIS context, not one of its own:
   * on iOS a second AudioContext means a second audio session competing with
   * the first over routing and output device, and the renegotiation that
   * causes is musie's documented prime suspect for a silent capture.
   */
  readonly context: AudioContext;
  readonly sampleRate: number;
  readonly stop: () => void;
  /**
   * Facts, not copy. Nothing renders these as sentences; they go in a bug
   * report — and `applied` is this spike's headline finding, because it is how
   * we learn whether iOS honoured `noiseSuppression: false` or ignored it.
   */
  readonly diagnostics: () => {
    sampleRate: number;
    contextState: string;
    trackMuted: boolean;
    trackState: MediaStreamTrackState;
    requested: Processing;
    applied: MediaTrackSettings;
    /** The input asked for, or null if we took whatever iOS offered. */
    wantedDeviceId: string | null;
    /** True when iOS refused the request and we fell back. */
    deviceRefused: boolean;
    /** The label of the track we ended up with, as the browser reports it. */
    trackLabel: string;
  };
};

function failureFor(error: unknown): CaptureFailure {
  const name = error instanceof DOMException ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'permissionDenied';
    case 'NotFoundError':
      return 'noDevice';
    case 'NotReadableError':
    case 'AbortError':
      return 'deviceBusy';
    case 'OverconstrainedError':
      return 'constraintsRejected';
    default:
      return 'trackArrivedDead';
  }
}

export async function openMicrophone(options: {
  processing: Processing;
  /**
   * The input we would LIKE. Asked for with `exact` so a refusal is visible,
   * then retried without it so a refusal is not fatal — see the comment at
   * the call below.
   */
  deviceId?: string | null;
  /**
   * Capture died after it had started — the track was muted or ended under us,
   * or the context was interrupted. Reported rather than thrown: by the time
   * this fires the promise has long resolved and there is nobody left to catch.
   */
  onInterrupted: (code: CaptureFailure) => void;
  /** Checked after every await. See the StrictMode note below. */
  isAborted: () => boolean;
}): Promise<Microphone> {
  const { processing, onInterrupted, isAborted } = options;

  /* getUserMedia does not exist at all outside a secure context, and on iOS
     that is the single most likely reason this spike appears broken: a LAN
     address is not a secure context, which is why the README says tunnel. */
  if (typeof navigator === 'undefined' || navigator.mediaDevices?.getUserMedia === undefined) {
    throw new MicrophoneError('insecureContext');
  }

  /**
   * ── ASK EXACTLY, THEN FALL BACK, AND RECORD WHICH HAPPENED ───────────────
   * `deviceId: { exact }` makes iOS throw OverconstrainedError rather than
   * quietly hand over a different microphone, which is the only way to learn
   * whether the route can be chosen from a web page at all.
   *
   * But a hard failure would make the app unusable on every device that does
   * not allow the choice, so a refusal is retried without the constraint and
   * remembered. The person still gets a working microphone; the diagnostics
   * still say it was not the one asked for.
   */
  let stream: MediaStream;
  let deviceRefused = false;
  const wanted = options.deviceId ?? null;

  const request = (withDevice: boolean) =>
    navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        ...processing,
        ...(withDevice && wanted !== null ? { deviceId: { exact: wanted } } : {}),
      },
    });

  try {
    stream = await request(wanted !== null);
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    const refusedTheDevice =
      wanted !== null && (name === 'OverconstrainedError' || name === 'NotFoundError');
    if (!refusedTheDevice) throw new MicrophoneError(failureFor(error));
    deviceRefused = true;
    try {
      stream = await request(false);
    } catch (fallbackError) {
      throw new MicrophoneError(failureFor(fallbackError));
    }
  }

  /**
   * ── REACT 19 STRICTMODE WILL LEAK THE MICROPHONE WITHOUT THIS ────────────
   * Effects mount twice in development, so the component can unmount while
   * this await is still outstanding. A stream that resolves after unmount is
   * never returned to anyone and never stopped — a live microphone indicator
   * and a held device, on every single dev reload.
   */
  if (isAborted()) {
    stream.getTracks().forEach((t) => t.stop());
    throw new MicrophoneError('trackArrivedDead');
  }

  /**
   * A TRACK CAN ARRIVE ALREADY DEAD and getUserMedia calls that success.
   * Checked here because everything below would otherwise build a perfectly
   * valid graph over nothing — which is the failure that reads as silence.
   */
  const [track] = stream.getAudioTracks();
  if (track === undefined || track.readyState === 'ended') {
    stream.getTracks().forEach((t) => t.stop());
    throw new MicrophoneError('trackArrivedDead');
  }

  /**
   * ── CONSTRUCTED AFTER THE AWAIT, DELIBERATELY ────────────────────────────
   * musie measured five cases against WebKit and found that A CAPTURING
   * DOCUMENT IS EXEMPT from WebKit's Web Audio autoplay gate: constructing the
   * context after getUserMedia has resolved starts rendering even with no user
   * activation at all. This is the one ordering that is exempt. Moving this
   * line above the await breaks iOS in a way no test here would catch.
   *
   * And NO sampleRate option. musie asks for 24 kHz for a transcription API's
   * sake; this spike wants the native rate and full bandwidth past 4 kHz,
   * because the /s/ discriminator lives up there — and requesting a rate on
   * iOS inserts a resampler of unknown response into the signal being
   * measured.
   */
  const context = new AudioContext();

  let analyser: AnalyserNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let silence: GainNode | null = null;
  let released = false;

  /**
   * ── ONE TEARDOWN, THREE CALLERS ──────────────────────────────────────────
   * The returned stop(), the catch below, and the abort check all mean the
   * same thing by "release the microphone", so they call the same code. In
   * musie this was learned the hard way: everything from the AudioContext down
   * once sat outside the try, so a throw leaked both the granted MediaStream
   * and the context, because the only thing that released them was a stop()
   * the function never got to return.
   */
  const release = () => {
    if (released) return;
    released = true;
    track.removeEventListener('mute', onMute);
    track.removeEventListener('ended', onEnded);
    context.onstatechange = null;
    source?.disconnect();
    analyser?.disconnect();
    silence?.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    void context.close();
  };

  /** Fired at most once: several events, one terminal fact. */
  let announced = false;
  const announce = (code: CaptureFailure) => {
    if (announced) return;
    announced = true;
    onInterrupted(code);
  };
  function onMute() { announce('trackMuted'); }
  function onEnded() { announce('trackEnded'); }

  try {
    analyser = context.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = SMOOTHING_TIME_CONSTANT;

    /* Installed BEFORE connecting, so an interruption during set-up counts. */
    track.addEventListener('mute', onMute);
    track.addEventListener('ended', onEnded);

    /**
     * WebKit has a non-standard 'interrupted' state that only a real iOS
     * audio-session interruption produces — a call, Siri — and which nothing
     * in musie reads. Recording which of these fires first is a free
     * measurement this spike can hand back.
     */
    context.onstatechange = () => {
      const state = context.state as string;
      if (state === 'interrupted') announce('contextInterrupted');
    };

    source = context.createMediaStreamSource(stream);

    /**
     * A node only runs while connected to the destination, but routing the
     * microphone to the speakers would howl — so pass through a silent gain
     * node instead. Whether an unconnected AnalyserNode is pulled by the
     * render graph is engine-dependent, and a dead analyser returns -Infinity
     * forever, which is precisely the "opened but silent" failure we are trying
     * to make reportable. One node removes the question.
     *
     * The cost, worth writing down: this couples microphone capture to
     * whatever iOS is doing with audio OUTPUT. The watchdogs detect the
     * consequence; nothing here decouples the cause.
     */
    silence = context.createGain();
    silence.gain.value = 0;
    source.connect(analyser).connect(silence).connect(context.destination);

    /**
     * ── RESUME, BUT DO NOT TRUST THE RESUME ──────────────────────────────
     * WebKit constructs a context suspended where Chromium constructs it
     * running. Measured, that is NOT a cause of silence — and reading
     * context.state immediately after construction returns 'suspended' on
     * EVERY engine, including inside a fresh gesture, because rendering starts
     * asynchronously.
     *
     * So this is belt and braces and it deliberately does not throw. The only
     * honest test of whether audio is flowing is whether a non-zero sample
     * ever arrives, and that lives in the calibration window.
     */
    if (context.state !== 'running') {
      await context.resume().catch(() => {
        /* The calibration window is the real test. */
      });
    }

    if (isAborted()) throw new MicrophoneError('trackArrivedDead');
  } catch (error) {
    release();
    throw error instanceof MicrophoneError ? error : new MicrophoneError('deviceBusy');
  }

  return {
    analyser,
    context,
    sampleRate: context.sampleRate,
    stop: release,
    diagnostics: () => ({
      sampleRate: context.sampleRate,
      contextState: context.state as string,
      trackMuted: track.muted,
      trackState: track.readyState,
      requested: processing,
      applied: track.getSettings(),
      wantedDeviceId: wanted,
      deviceRefused,
      trackLabel: track.label,
    }),
  };
}

/**
 * Keep the screen awake while listening.
 *
 * Not a nicety. A screen that sleeps during a twenty-second breathing test
 * stops requestAnimationFrame, which manufactures a spurious `noFrames`
 * failure and wastes the tester's time chasing it. iOS Safari 16.4+; degrades
 * silently everywhere else.
 */
export async function keepAwake(): Promise<() => void> {
  type WakeLockNavigator = Navigator & {
    wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
  };
  const wakeLock = (navigator as WakeLockNavigator).wakeLock;
  if (wakeLock === undefined) return () => {};
  try {
    const sentinel = await wakeLock.request('screen');
    return () => void sentinel.release().catch(() => {});
  } catch {
    return () => {};
  }
}
