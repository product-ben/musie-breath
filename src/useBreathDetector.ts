import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_PROCESSING, MicrophoneError, keepAwake, openMicrophone } from './audio/openMicrophone';
import type { Processing } from './audio/openMicrophone';
import { calibrate } from './detect/calibrate';
import type { CalibrationSample } from './detect/calibrate';
import {
  CALIBRATION_DISCARD_MS,
  CALIBRATION_MEASURE_MS,
  DEFAULT_CONFIG,
  FFT_SIZE,
} from './detect/config';
import type { DetectorConfig } from './detect/config';
import { initialDetectorState, stepDetector } from './detect/decide';
import type { DetectorState } from './detect/decide';
import { bandBins, extractFeatures, hasSignal, rmsOf, rmsToDb } from './detect/features';
import type { BandBins, FeatureFrame, Floor } from './detect/features';
import { captureVerdict, detectionVerdict } from './detect/status';
import type { CaptureStatus, DetectionVerdict } from './detect/status';

/**
 * The join between the effectful microphone and the pure core.
 *
 * ── WHY NOTHING HERE GOES THROUGH setState AT FRAME RATE ───────────────────
 * Ten values changing at 60–120 Hz through useState would re-render the tree
 * sixty times a second, and on a phone that causes real requestAnimationFrame
 * jitter. rAF jitter corrupts `dt`, and `dt` is what every smoothing
 * coefficient is derived from — so a 60 Hz React render loop would not merely
 * be wasteful, IT WOULD CORRUPT THE MEASUREMENT.
 *
 * So the live values live in a ref that the consumer reads from inside its own
 * rAF loop, and React state carries only things that change rarely: the
 * capture status, the floor, the config.
 */

export type Live = {
  frame: FeatureFrame | null;
  detector: DetectorState;
  fps: number;
  verdict: DetectionVerdict;
};

export type Diagnostics = ReturnType<
  Awaited<ReturnType<typeof openMicrophone>>['diagnostics']
>;

export function useBreathDetector() {
  const [status, setStatus] = useState<CaptureStatus>({ kind: 'idle' });
  const [processing, setProcessing] = useState<Processing>(DEFAULT_PROCESSING);
  const [config, setConfig] = useState<DetectorConfig>(DEFAULT_CONFIG);
  const [floor, setFloor] = useState<Floor | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [generation, setGeneration] = useState(0);

  /** Read by the consumer's own rAF loop. Never triggers a render. */
  const live = useRef<Live>({
    frame: null,
    detector: initialDetectorState(0),
    fps: 0,
    verdict: 'waiting',
  });

  /** Latest config without re-running the capture effect on every slider move. */
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    if (status.kind === 'idle' && generation === 0) return;

    let aborted = false;
    let raf = 0;
    let releaseWake: () => void = () => {};
    let stopMic: () => void = () => {};

    const start = async () => {
      setStatus(generation > 1 ? { kind: 'reopening' } : { kind: 'opening' });
      let mic: Awaited<ReturnType<typeof openMicrophone>>;
      try {
        mic = await openMicrophone({
          processing,
          isAborted: () => aborted,
          onInterrupted: (code) => {
            if (!aborted) setStatus({ kind: 'failed', code });
          },
        });
      } catch (error) {
        if (aborted) return;
        const code = error instanceof MicrophoneError ? error.code : 'deviceBusy';
        setStatus({ kind: 'failed', code });
        return;
      }
      if (aborted) {
        mic.stop();
        return;
      }

      stopMic = mic.stop;
      releaseWake = await keepAwake();
      setDiagnostics(mic.diagnostics());

      const bins: BandBins = bandBins(mic.sampleRate, FFT_SIZE);
      const timeDomain = new Float32Array(FFT_SIZE);
      const binsDb = new Float32Array(FFT_SIZE / 2);

      /* ── The calibration window, which doubles as the proof of capture ──── */
      const startedAt = performance.now();
      const samples: CalibrationSample[] = [];
      const framesNeeded = Math.round((CALIBRATION_MEASURE_MS / 1000) * 60);
      setStatus({ kind: 'calibrating', framesDone: 0, framesNeeded });

      let measuredFloor: Floor | null = null;
      let detector = initialDetectorState(startedAt);
      let lastAt = startedAt;
      let lastFrameAt = startedAt;
      let lastSignalAt = startedAt;
      let listeningSince = 0;
      let previousRmsDb: number | undefined;
      let fpsAccum = 0;
      let fpsCount = 0;

      const tick = () => {
        if (aborted) return;
        raf = requestAnimationFrame(tick);

        const now = performance.now();
        const dt = Math.min(100, now - lastAt);
        lastAt = now;
        lastFrameAt = now;

        mic.analyser.getFloatTimeDomainData(timeDomain);
        mic.analyser.getFloatFrequencyData(binsDb);

        if (hasSignal(timeDomain)) lastSignalAt = now;

        fpsAccum += dt;
        fpsCount += 1;
        if (fpsAccum >= 500) {
          live.current.fps = Math.round((fpsCount / fpsAccum) * 1000);
          fpsAccum = 0;
          fpsCount = 0;
        }

        /* ── Phase 1: calibrating ──────────────────────────────────────── */
        if (measuredFloor === null) {
          const elapsed = now - startedAt;
          if (elapsed >= CALIBRATION_DISCARD_MS) {
            samples.push({
              timeDomain: Float32Array.from(timeDomain),
              binsDb: Float32Array.from(binsDb),
            });
            setStatus({ kind: 'calibrating', framesDone: samples.length, framesNeeded });
          }
          if (elapsed < CALIBRATION_DISCARD_MS + CALIBRATION_MEASURE_MS) return;

          const result = calibrate(samples, bins, FFT_SIZE, now);
          if (!result.ok) {
            setStatus({ kind: 'failed', code: result.code });
            cancelAnimationFrame(raf);
            return;
          }
          measuredFloor = result.floor;
          setFloor(result.floor);
          setStatus({ kind: 'listening' });
          setDiagnostics(mic.diagnostics());
          listeningSince = now;
          detector = initialDetectorState(now);
          return;
        }

        /* ── Phase 2: listening ────────────────────────────────────────── */
        const verdict = captureVerdict({
          now,
          lastFrameAt,
          lastSignalAt,
          hidden: document.visibilityState === 'hidden',
        });
        if (verdict === 'captureLost') {
          setStatus({ kind: 'failed', code: 'captureLost' });
          cancelAnimationFrame(raf);
          return;
        }

        const frame = extractFeatures({
          timeDomain,
          binsDb,
          floor: measuredFloor,
          bins,
          at: now,
          dt,
          shapeValidExcessDb: configRef.current.shapeValidExcessDb,
          previousRmsDb,
        });
        previousRmsDb = rmsToDb(rmsOf(timeDomain));

        detector = stepDetector(detector, frame, configRef.current);

        live.current.frame = frame;
        live.current.detector = detector;
        live.current.verdict = detectionVerdict({
          listeningForMs: now - listeningSince,
          completed: detector.completed,
          blocked: detector.phase === 'blocked',
        });

        /**
         * A scripting hook, on purpose.
         *
         * The phone is under your chin during a breath, so the on-screen
         * readout cannot be read at the moment it matters. This lets a
         * Playwright probe — or the Safari console over USB — sample the exact
         * same values the detector just decided on. It is the only way to get
         * real numbers out of this thing without a recording path.
         */
        (window as unknown as { __breath?: unknown }).__breath = {
          frame,
          detector,
          fps: live.current.fps,
          floor: { rmsDb: measuredFloor.rmsDb, bandPower: Array.from(measuredFloor.bandPower) },
        };
      };

      raf = requestAnimationFrame(tick);
    };

    void start();

    return () => {
      aborted = true;
      cancelAnimationFrame(raf);
      releaseWake();
      stopMic();
    };
    /* `processing` and `generation` are the only things that justify reopening
       the stream: both are getUserMedia constraints or an explicit restart.
       `config` deliberately is NOT here — it is read through configRef so a
       slider move retunes without costing a 1.5 s recalibration. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processing, generation]);

  const begin = useCallback(() => setGeneration((g) => g + 1), []);
  const reopen = useCallback(() => setGeneration((g) => g + 1), []);
  const recalibrate = useCallback(() => setGeneration((g) => g + 1), []);

  return {
    status,
    live,
    floor,
    diagnostics,
    config,
    setConfig,
    processing,
    setProcessing,
    begin,
    reopen,
    recalibrate,
    started: generation > 0,
  };
}
