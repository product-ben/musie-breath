import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_PROCESSING, MicrophoneError, keepAwake, openMicrophone } from './audio/openMicrophone';
import type { Processing } from './audio/openMicrophone';
import { createPlayback } from './audio/playback';
import type { Playback } from './audio/playback';
import { calibrate } from './detect/calibrate';
import type { CalibrationSample } from './detect/calibrate';
import {
  CALIBRATION_DISCARD_MS,
  CALIBRATION_MEASURE_MS,
  DEFAULT_CONFIG,
  FFT_SIZE,
  LEAK_MEASURE_MS,
} from './detect/config';
import type { DetectorConfig } from './detect/config';
import { LEAK_FATAL_DB, MIN_CONFIDENCE, dynamicFloor, estimateCoupling } from './detect/coupling';
import type { Coupling, CouplingSample } from './detect/coupling';
import { initialDetectorState, stepDetector } from './detect/decide';
import type { DetectorState } from './detect/decide';
import { bandBins, bandPowers, extractFeatures, hasSignal, rmsOf, rmsToDb } from './detect/features';
import type { BandBins, FeatureFrame, Floor } from './detect/features';
import { captureVerdict, detectionVerdict } from './detect/status';
import type { CaptureStatus, DetectionVerdict } from './detect/status';

/**
 * The join between the effectful microphone, the track, and the pure core.
 *
 * ── WHY NOTHING HERE GOES THROUGH setState AT FRAME RATE ───────────────────
 * Ten values changing at 60–120 Hz through useState would re-render the tree
 * sixty times a second, and on a phone that causes real requestAnimationFrame
 * jitter. rAF jitter corrupts `dt`, and `dt` is what every smoothing
 * coefficient derives from — so a 60 Hz React render loop would not merely be
 * wasteful, IT WOULD CORRUPT THE MEASUREMENT.
 *
 * ── THREE PHASES, IN THIS ORDER, EACH NEEDING THE ONE BEFORE ───────────────
 *   1. room floor    — silence. Also the proof the graph renders at all.
 *   2. speaker leak  — pink noise. Needs the room floor to subtract from.
 *   3. listening     — the track plays; the floor becomes room + predicted leak.
 */

export type Live = {
  frame: FeatureFrame | null;
  detector: DetectorState;
  fps: number;
  verdict: DetectionVerdict;
  /** Band powers of what the speaker is playing right now. */
  played: readonly [number, number, number] | null;
};

export type Diagnostics = ReturnType<
  Awaited<ReturnType<typeof openMicrophone>>['diagnostics']
>;

/** How far back the microphone is hearing. See the ring buffer below. */
const LAG_RING = 32;

export function useBreathDetector() {
  const [status, setStatus] = useState<CaptureStatus>({ kind: 'idle' });
  const [processing, setProcessing] = useState<Processing>(DEFAULT_PROCESSING);
  const [config, setConfig] = useState<DetectorConfig>(DEFAULT_CONFIG);
  const [floor, setFloor] = useState<Floor | null>(null);
  const [coupling, setCoupling] = useState<Coupling | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [generation, setGeneration] = useState(0);
  const [trackState, setTrackState] = useState({ source: 'none' as 'none' | 'file' | 'pad', playing: false, name: '' });
  const [volume, setVolumeState] = useState(0.6);
  const [lagMs, setLagMs] = useState(25);

  const live = useRef<Live>({
    frame: null, detector: initialDetectorState(0), fps: 0, verdict: 'waiting', played: null,
  });

  /** Latest values the rAF loop needs, without re-running the capture effect. */
  const configRef = useRef(config);
  configRef.current = config;
  const lagRef = useRef(lagMs);
  lagRef.current = lagMs;
  const playbackRef = useRef<Playback | null>(null);
  /** Survives a stream reopen, so a picked file is not lost on a toggle flip. */
  const pendingFile = useRef<File | null>(null);
  const pendingPad = useRef(false);

  useEffect(() => {
    if (status.kind === 'idle' && generation === 0) return;

    let aborted = false;
    let raf = 0;
    let releaseWake: () => void = () => {};
    let stopMic: () => void = () => {};
    let playback: Playback | null = null;

    const start = async () => {
      setStatus(generation > 1 ? { kind: 'reopening' } : { kind: 'opening' });
      let mic: Awaited<ReturnType<typeof openMicrophone>>;
      try {
        mic = await openMicrophone({
          processing,
          isAborted: () => aborted,
          onInterrupted: (code) => { if (!aborted) setStatus({ kind: 'failed', code }); },
        });
      } catch (error) {
        if (aborted) return;
        setStatus({ kind: 'failed', code: error instanceof MicrophoneError ? error.code : 'deviceBusy' });
        return;
      }
      if (aborted) { mic.stop(); return; }

      stopMic = mic.stop;
      releaseWake = await keepAwake();
      setDiagnostics(mic.diagnostics());

      /* Playback shares the microphone's context — one audio session. */
      playback = createPlayback(mic.context);
      playbackRef.current = playback;
      playback.setVolume(volume);
      if (pendingFile.current !== null) playback.loadFile(pendingFile.current);
      else if (pendingPad.current) playback.useGeneratedPad();
      setTrackState(playback.state());

      const bins: BandBins = bandBins(mic.sampleRate, FFT_SIZE);
      const micTime = new Float32Array(FFT_SIZE);
      const micDb = new Float32Array(FFT_SIZE / 2);
      const playTime = new Float32Array(FFT_SIZE);
      const playDb = new Float32Array(FFT_SIZE / 2);

      const startedAt = performance.now();
      const roomSamples: CalibrationSample[] = [];
      const leakSamples: CouplingSample[] = [];
      const framesNeeded = Math.round((CALIBRATION_MEASURE_MS / 1000) * 60);
      const leakFramesNeeded = Math.round((LEAK_MEASURE_MS / 1000) * 60);
      setStatus({ kind: 'calibrating', framesDone: 0, framesNeeded });

      type Phase = 'room' | 'leak' | 'listening';
      let phase: Phase = 'room';
      let phaseStart = startedAt;
      let measuredFloor: Floor | null = null;
      let measuredCoupling: Coupling | null = null;
      let detector = initialDetectorState(startedAt);
      let lastAt = startedAt;
      let lastFrameAt = startedAt;
      let lastSignalAt = startedAt;
      let listeningSince = 0;
      let previousRmsDb: number | undefined;
      let fpsAccum = 0;
      let fpsCount = 0;

      /**
       * A ring of recent playback band powers, because THE MICROPHONE HEARS
       * THE PAST. Output buffering plus the acoustic hop puts the speaker's
       * sound at the mic some tens of milliseconds after the analyser saw it,
       * so subtracting the CURRENT playback spectrum would misalign during
       * exactly the moments that matter — transients, where the spectrum is
       * changing fastest.
       */
      const ring: { at: number; band: [number, number, number]; rms: number }[] = [];
      const delayed = (now: number) => {
        const want = now - lagRef.current;
        let best = ring[0];
        for (const entry of ring) if (entry.at <= want) best = entry;
        return best;
      };

      const tick = () => {
        if (aborted) return;
        raf = requestAnimationFrame(tick);

        const now = performance.now();
        const dt = Math.min(100, now - lastAt);
        lastAt = now;
        lastFrameAt = now;

        mic.analyser.getFloatTimeDomainData(micTime);
        mic.analyser.getFloatFrequencyData(micDb);
        if (hasSignal(micTime)) lastSignalAt = now;

        const pb = playback;
        if (pb !== null) {
          pb.analyser.getFloatTimeDomainData(playTime);
          pb.analyser.getFloatFrequencyData(playDb);
        }
        const playedBand = bandPowers(playDb, bins);
        const playedRms = rmsOf(playTime) ** 2;
        live.current.played = playedBand;
        ring.push({ at: now, band: playedBand, rms: playedRms });
        while (ring.length > LAG_RING) ring.shift();

        fpsAccum += dt;
        fpsCount += 1;
        if (fpsAccum >= 500) {
          live.current.fps = Math.round((fpsCount / fpsAccum) * 1000);
          fpsAccum = 0; fpsCount = 0;
        }

        /* ── Phase 1: the room, in silence ─────────────────────────────── */
        if (phase === 'room') {
          const elapsed = now - phaseStart;
          if (elapsed >= CALIBRATION_DISCARD_MS) {
            roomSamples.push({
              timeDomain: Float32Array.from(micTime),
              binsDb: Float32Array.from(micDb),
            });
            setStatus({ kind: 'calibrating', framesDone: roomSamples.length, framesNeeded });
          }
          if (elapsed < CALIBRATION_DISCARD_MS + CALIBRATION_MEASURE_MS) return;

          const result = calibrate(roomSamples, bins, FFT_SIZE, now);
          if (!result.ok) {
            setStatus({ kind: 'failed', code: result.code });
            cancelAnimationFrame(raf);
            return;
          }
          measuredFloor = result.floor;
          setFloor(result.floor);

          /* No track at all? Then there is no leak to measure. */
          if (pb === null || pb.state().source === 'none') {
            phase = 'listening';
            phaseStart = now;
            listeningSince = now;
            detector = initialDetectorState(now);
            setStatus({ kind: 'listening' });
            return;
          }

          phase = 'leak';
          phaseStart = now;
          pb.startPink();
          setStatus({ kind: 'measuringLeak', framesDone: 0, framesNeeded: leakFramesNeeded });
          return;
        }

        /* ── Phase 2: what the speaker puts back into the mic ──────────── */
        if (phase === 'leak') {
          const elapsed = now - phaseStart;
          const floorNow = measuredFloor;
          if (floorNow === null) return;
          /**
           * THE LEVEL HAS TO MOVE, or there is no slope to fit.
           *
           * Stepped rather than swept, in ~180 ms blocks, so each level holds
           * long enough for several 42.7 ms analysis windows to sit entirely
           * inside it rather than straddling a change.
           */
          const step = Math.floor(elapsed / 180) % 3;
          pb?.setPinkLevel(step === 0 ? 1 : step === 1 ? 0.35 : 0.12);

          /* Discard the first frames: the gain ramp and the buffer fill. */
          if (elapsed >= 200) {
            leakSamples.push({
              played: playedBand,
              heard: bandPowers(micDb, bins),
              playedRms,
              heardRms: rmsOf(micTime) ** 2,
            });
            setStatus({ kind: 'measuringLeak', framesDone: leakSamples.length, framesNeeded: leakFramesNeeded });
          }
          if (elapsed < 200 + LEAK_MEASURE_MS) return;

          pb?.stopPink();
          const roomRmsPower = Math.pow(10, floorNow.rmsDb / 10);
          const c = estimateCoupling(leakSamples, roomRmsPower);
          measuredCoupling = c;
          setCoupling(c);

          /**
           * A fit this poor means something uncorrelated was happening during
           * the burst, so these coefficients are not evidence and subtracting
           * with them would disarm the detector for the whole session. Better
           * to carry on with the static room floor and SAY SO than to trust a
           * number that was never measured.
           */
          if (c.confidence < MIN_CONFIDENCE) measuredCoupling = null;

          if (c.leakDb >= LEAK_FATAL_DB) {
            setStatus({ kind: 'failed', code: 'trackDrowningMic' });
            cancelAnimationFrame(raf);
            return;
          }

          phase = 'listening';
          phaseStart = now;
          listeningSince = now;
          detector = initialDetectorState(now);
          setStatus({ kind: 'listening' });
          setDiagnostics(mic.diagnostics());
          void pb?.playTrack().then(() => { if (!aborted && pb !== null) setTrackState(pb.state()); });
          return;
        }

        /* ── Phase 3: listening, with the track playing ────────────────── */
        const floorNow = measuredFloor;
        if (floorNow === null) return;

        const verdict = captureVerdict({
          now, lastFrameAt, lastSignalAt,
          hidden: document.visibilityState === 'hidden',
        });
        if (verdict === 'captureLost') {
          setStatus({ kind: 'failed', code: 'captureLost' });
          cancelAnimationFrame(raf);
          return;
        }

        const past = delayed(now);
        const roomRmsPower = Math.pow(10, floorNow.rmsDb / 10);
        const dyn = dynamicFloor(
          floorNow.bandPower, roomRmsPower, measuredCoupling,
          past?.band ?? null, past?.rms ?? 0,
        );

        const frame = extractFeatures({
          timeDomain: micTime,
          binsDb: micDb,
          floor: floorNow,
          bins,
          at: now,
          dt,
          shapeValidExcessDb: configRef.current.shapeValidExcessDb,
          previousRmsDb,
          floorOverride: measuredCoupling === null ? undefined : dyn,
        });
        previousRmsDb = rmsToDb(rmsOf(micTime));

        detector = stepDetector(detector, frame, configRef.current);

        live.current.frame = frame;
        live.current.detector = detector;
        live.current.verdict = detectionVerdict({
          listeningForMs: now - listeningSince,
          completed: detector.completed,
          blocked: detector.phase === 'blocked',
        });

        /**
         * A scripting hook, on purpose. The phone is under your chin during a
         * breath, so the on-screen readout cannot be read at the moment it
         * matters; this lets a Playwright probe or the Safari console over USB
         * sample exactly what the detector just decided on.
         */
        (window as unknown as { __breath?: unknown }).__breath = {
          frame, detector, fps: live.current.fps,
          floor: { rmsDb: floorNow.rmsDb, bandPower: Array.from(floorNow.bandPower) },
          dynamicFloorRmsDb: dyn.rmsDb,
          coupling: measuredCoupling,
          played: playedBand,
        };
      };

      raf = requestAnimationFrame(tick);
    };

    void start();

    return () => {
      aborted = true;
      cancelAnimationFrame(raf);
      releaseWake();
      /* The track is paused EXPLICITLY before the context goes, rather than
         left to React detaching the element — musie's §3.2 first domino. */
      playback?.pauseTrack();
      playback?.dispose();
      playbackRef.current = null;
      stopMic();
    };
    /* `processing` and `generation` are the only things that justify reopening
       the stream. `config`, `volume` and `lagMs` are read through refs so a
       slider move does not cost a three-second recalibration. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processing, generation]);

  const setVolume = useCallback((v: number) => {
    setVolumeState(v);
    playbackRef.current?.setVolume(v);
  }, []);

  const loadFile = useCallback((file: File) => {
    pendingFile.current = file;
    pendingPad.current = false;
    setGeneration((g) => g + 1);
  }, []);

  const useGeneratedPad = useCallback(() => {
    pendingFile.current = null;
    pendingPad.current = true;
    setGeneration((g) => g + 1);
  }, []);

  const toggleTrack = useCallback(async () => {
    const pb = playbackRef.current;
    if (pb === null) return;
    if (pb.state().playing) pb.pauseTrack();
    else await pb.playTrack();
    setTrackState(pb.state());
  }, []);

  const restart = useCallback(() => setGeneration((g) => g + 1), []);

  return {
    status, live, floor, coupling, diagnostics,
    config, setConfig, processing, setProcessing,
    volume, setVolume, lagMs, setLagMs,
    trackState, loadFile, useGeneratedPad, toggleTrack,
    begin: restart, reopen: restart, recalibrate: restart,
    started: generation > 0,
  };
}
