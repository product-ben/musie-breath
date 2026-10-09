import { useEffect, useRef, useState } from 'react';
import { LEAK_WARN_DB, MIN_CONFIDENCE } from './detect/coupling';
import type { DetectorConfig } from './detect/config';
import { isRecoverable } from './detect/status';
import { CandleGL } from './ui/CandleGL';
import type { CandleState } from './ui/candle';
import { Chips } from './ui/Chips';
import { Instrument } from './ui/Instrument';
import { useBreathDetector } from './useBreathDetector';

const STORAGE_KEY = 'musie-breath-config';

/** The dials worth exposing on a phone, with their ranges. */
const SLIDERS: readonly {
  key: keyof DetectorConfig; label: string; min: number; max: number; step: number;
}[] = [
  { key: 'onsetExcessDb', label: 'onset dB over floor', min: 3, max: 30, step: 1 },
  { key: 'sustainExcessDb', label: 'sustain dB over floor', min: 1, max: 25, step: 1 },
  { key: 'minLowRatio', label: 'min low ratio', min: 0, max: 0.9, step: 0.01 },
  { key: 'maxHighRatio', label: 'max high ratio', min: 0.05, max: 1, step: 0.01 },
  { key: 'maxFlatnessDb', label: 'max flatness dB', min: -40, max: -2, step: 1 },
  { key: 'minOnsetMs', label: 'min onset ms', min: 50, max: 1200, step: 10 },
  { key: 'releaseMs', label: 'release ms', min: 40, max: 800, step: 10 },
  { key: 'attackTauMs', label: 'attack tau ms', min: 10, max: 400, step: 5 },
  { key: 'releaseTauMs', label: 'release tau ms', min: 50, max: 1500, step: 10 },
];

export function App() {
  const {
    status, live, floor, coupling, diagnostics, config, setConfig,
    devices, wantedDeviceId, setWantedDeviceId, route, leak,
    processing, setProcessing, begin, reopen, started,
    volume, setVolume, lagMs, setLagMs,
    trackState, loadFile, useGeneratedPad, toggleTrack,
  } = useBreathDetector();

  const [candle, setCandle] = useState<CandleState | null>(null);
  const [tuning, setTuning] = useState(false);
  const [copied, setCopied] = useState(false);
  const loaded = useRef(false);

  /* Persisted, because a spike where you lose your tuning on every reload is
     a spike nobody finishes. */
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw !== null) setConfig((c) => ({ ...c, ...JSON.parse(raw) }));
    } catch { /* a spike must survive a corrupt key */ }
  }, [setConfig]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* ignore */ }
  }, [config]);

  const verdict = live.current?.verdict ?? 'waiting';
  const breaths = live.current?.detector.completed ?? 0;

  const copyDiagnostics = async () => {
    const blob = {
      at: new Date().toISOString(),
      status,
      requested: processing,
      applied: diagnostics?.applied ?? null,
      sampleRate: diagnostics?.sampleRate ?? null,
      contextState: diagnostics?.contextState ?? null,
      floor: floor === null ? null : {
        rmsDb: Number(floor.rmsDb.toFixed(2)),
        rmsIqrDb: Number(floor.rmsIqrDb.toFixed(2)),
        flatnessDb: Number(floor.flatnessDb.toFixed(2)),
        sampleRate: floor.sampleRate,
        framesUsed: floor.framesUsed,
      },
      config,
      detector: live.current?.detector ?? null,
      userAgent: navigator.userAgent,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(blob, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard refused; nothing to do on a spike */ }
  };

  return (
    <div className="breath-root">
      <div className="breath-stage">
        <CandleGL live={live} onCandle={setCandle} />
        {!started && (
          <div className="breath-gate">
            <h1>Breathe out at your phone</h1>
            <p>
              Hold the phone near your mouth. It listens to the room for a second
              and a half first, then watches for an out-breath on its own.
            </p>
            <button type="button" className="breath-button is-primary" onClick={begin}>
              Start listening
            </button>
          </div>
        )}
      </div>

      <Chips status={status} verdict={verdict} breaths={breaths} />

      {started && candle !== null && (
        <p className="breath-readout">
          flame {candle.phase}
          {'  ·  '}life {candle.life.toFixed(2)}
          {'  ·  '}lean {candle.lean.toFixed(2)}
          {'  ·  '}blown out {candle.blowouts}
          {'  ·  '}peak {(live.current?.frame?.peak ?? 0).toFixed(3)}
        </p>
      )}

      {status.kind === 'failed' && (
        <p className="breath-failure">
          {FAILURE_TEXT[status.code] ?? status.code}
          {isRecoverable(status.code) && (
            <button type="button" className="breath-button" onClick={reopen}>Try again</button>
          )}
        </p>
      )}

      {started && <Instrument live={live} config={config} />}

      {started && (
        <>
          <div className="breath-section">
            <h2>Which microphone</h2>
            <p className="breath-note">
              Listening on headphones while capturing on the phone itself is the
              combination worth having: nothing leaks into the capture and the
              built-in microphone keeps its full bandwidth. iOS does not offer
              it by default — headphones normally take the capture route too,
              and over Bluetooth that means narrowband. This asks for the
              built-in one and reports what it was actually given.
            </p>

            {devices.length === 0 ? (
              <p className="breath-note">
                No inputs enumerated yet. Labels only appear once the microphone
                has been granted, so this fills in after the first start.
              </p>
            ) : (
              <div className="breath-sliders">
                {devices.map((d) => (
                  <label key={d.deviceId} className="breath-toggle">
                    <input
                      type="radio"
                      name="mic"
                      checked={wantedDeviceId === d.deviceId}
                      onChange={() => setWantedDeviceId(d.deviceId)}
                    />
                    <span className="breath-toggle-label">{d.label}</span>
                    <span className="breath-applied">{d.kind}</span>
                  </label>
                ))}
                <label className="breath-toggle">
                  <input
                    type="radio"
                    name="mic"
                    checked={wantedDeviceId === null}
                    onChange={() => setWantedDeviceId(null)}
                  />
                  <span className="breath-toggle-label">whatever iOS picks</span>
                  <span className="breath-applied">default</span>
                </label>
              </div>
            )}

            {/* The measurement. Asked versus got, for the route this time. */}
            <pre className="breath-pre" style={{ marginTop: 10 }}>
{`asked for   ${wantedDeviceId === null ? 'no preference' : `${devices.find((d) => d.deviceId === wantedDeviceId)?.label ?? wantedDeviceId}`}
got         ${diagnostics?.trackLabel === undefined || diagnostics.trackLabel === '' ? '(no label)' : diagnostics.trackLabel}
capture at  ${diagnostics?.sampleRate ?? '—'} Hz
route says  ${route === null ? '—' : `${route.likely}${route.narrowband ? ', narrowband' : ', full band'}`}`}
            </pre>

            {diagnostics?.deviceRefused === true && (
              <p className="breath-warn">
                iOS refused the microphone that was asked for and gave this one
                instead. So the capture route cannot be chosen from a web page
                on this device — which is itself the answer to the question, and
                means the only lever left is which headphones you use.
              </p>
            )}

            {route !== null && route.narrowband && (
              <p className="breath-warn">
                Capturing at {diagnostics?.sampleRate} Hz. That is narrowband,
                which is near-proof of a Bluetooth headset microphone: there is
                no 4–8 kHz band, so the sibilant rejector does not exist and a
                long /s/ will read as a breath. Wired headphones — ideally ones
                with no microphone of their own — should hand capture back to
                the phone.
              </p>
            )}

            {route !== null && !route.narrowband && coupling !== null
              && coupling.confidence >= MIN_CONFIDENCE
              && Number.isFinite(coupling.leakDb) && coupling.leakDb > 6 && (
              <p className="breath-warn">
                Full-band capture, but the speaker leak still measures{' '}
                {coupling.leakDb.toFixed(0)} dB. On headphones that is the
                signature of a headset microphone sitting inches from its own
                driver — the track is going into the microphone rather than only
                into your ears.
              </p>
            )}
          </div>

          <div className="breath-section">
            <h2>The track</h2>
            <p className="breath-note">
              Played through the microphone's own audio context, so there is one
              iOS audio session rather than two competing over routing. The
              spectrum is tapped after the volume, which keeps the measured leak
              independent of how loud you set it. The first few seconds of the
              track double as the leak measurement — its own dynamics are the
              test signal, so nothing extra is ever played at you.
            </p>
            <div className="breath-buttons">
              <label className="breath-button">
                Choose a file
                <input
                  type="file"
                  accept="audio/*"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file !== undefined) loadFile(file);
                  }}
                />
              </label>
              <button type="button" className="breath-button" onClick={useGeneratedPad}>
                Generated pad
              </button>
              <button
                type="button"
                className="breath-button"
                disabled={trackState.source === 'none'}
                onClick={() => void toggleTrack()}
              >
                {trackState.playing ? 'Pause' : 'Play'}
              </button>
            </div>
            <p className="breath-note" style={{ marginTop: 10 }}>
              {trackState.source === 'none'
                ? 'Nothing loaded — the leak measurement is skipped entirely.'
                : trackState.name}
            </p>
            <label className="breath-slider">
              <span>volume</span>
              <input
                type="range" min={0} max={1} step={0.01} value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
              />
              <output>{volume.toFixed(2)}</output>
            </label>
            {/* The measurement this whole section exists for. */}
            <pre className="breath-pre" style={{ marginTop: 10 }}>
{`speaker leak  ${coupling === null ? '— not measured' : Number.isFinite(coupling.leakDb) ? `${coupling.leakDb.toFixed(1)} dB over the room floor` : 'none detected'}
verdict       ${coupling === null ? '—' : leak}
coupling      ${coupling === null ? '—' : coupling.band.map((v) => v.toExponential(1)).join('  ')}
fit           ${coupling === null ? '—' : leak === 'none' ? 'n/a — nothing to fit' : `r² ${coupling.confidence.toFixed(3)}${coupling.confidence < MIN_CONFIDENCE ? '  NOT TRUSTED' : ''}`}
track drive   ${coupling === null ? '—' : coupling.drive.toFixed(3)}
frames used   ${coupling?.framesUsed ?? '—'}`}
            </pre>
            {coupling !== null && leak === 'none' && (
              <p className="breath-note">
                <strong>No measurable leak.</strong> The speaker is not reaching
                the microphone, which is what headphones are supposed to do.
                The floor stays static and the detector behaves exactly as it
                does in silence — the easy case, and the one worth having.
              </p>
            )}

            {coupling !== null && leak === 'measured' && coupling.leakDb < LEAK_WARN_DB && (
              <p className="breath-note">
                A real leak, fitted well, and small enough to subtract. The
                floor now rises and falls with the track.
              </p>
            )}

            {coupling !== null && leak === 'measured' && coupling.leakDb >= LEAK_WARN_DB && (
              <p className="breath-warn">
                The track is reaching the microphone {coupling.leakDb.toFixed(0)} dB
                above the room. Subtraction is being asked to remove more than a
                breath is worth, so a missed or a phantom breath is likely.
                Headphones, or less volume.
              </p>
            )}

            {coupling !== null && leak === 'unmeasurable' && (
              <p className="breath-warn">
                This track's level barely moves (drive {coupling.drive.toFixed(3)}).
                The leak is measured as a slope against that level, so a drone
                offers nothing to measure against. Not a problem if you are on
                headphones — there is likely nothing to subtract anyway — but on
                a speaker it means the leak is unknown rather than absent.
              </p>
            )}

            {coupling !== null && leak === 'untrusted' && (
              <p className="breath-warn">
                A real leak appeared but the fit is poor (r² {coupling.confidence.toFixed(2)}),
                so something the speaker was not causing was happening
                throughout. The coefficients are being ignored rather than
                trusted — the floor stays static. Let the track play a few
                seconds without breathing at it, then recalibrate.
              </p>
            )}
          </div>

          <div className="breath-section">
            <h2>getUserMedia constraints</h2>
            <p className="breath-note">
              All three off by default. Each is tuned for speech; noise suppression
              is built to discard non-speech, and auto gain moves the noise floor
              after it has been measured. Flipping one reopens the stream and
              recalibrates.
            </p>
            {(['echoCancellation', 'noiseSuppression', 'autoGainControl'] as const).map((key) => {
              const applied = diagnostics?.applied as Record<string, unknown> | undefined;
              const got = applied?.[key];
              const honoured = got === undefined ? null : got === processing[key];
              return (
                <label key={key} className="breath-toggle">
                  <input
                    type="checkbox"
                    checked={processing[key]}
                    onChange={(e) =>
                      setProcessing((p) => ({ ...p, [key]: e.target.checked }))}
                  />
                  <span className="breath-toggle-label">{key}</span>
                  {/* The three highest-value characters on this screen: what
                      iOS ACTUALLY gave us, not what we asked for. */}
                  <span className={`breath-applied ${honoured === false ? 'is-bad' : ''}`}>
                    {got === undefined ? 'got —' : `got ${String(got)}`}
                    {honoured === false ? ' ⚠ ignored' : ''}
                  </span>
                </label>
              );
            })}
          </div>

          <div className="breath-section">
            <h2>Measured</h2>
            <pre className="breath-pre">
{`sample rate   ${diagnostics?.sampleRate ?? '—'} Hz
context       ${diagnostics?.contextState ?? '—'}
track         ${diagnostics?.trackState ?? '—'}${diagnostics?.trackMuted === true ? ' (muted)' : ''}
floor         ${floor === null ? '—' : `${floor.rmsDb.toFixed(1)} dBFS  iqr ${floor.rmsIqrDb.toFixed(1)} dB`}
floor flatness${floor === null ? ' —' : ` ${floor.flatnessDb.toFixed(1)} dB`}
frames used   ${floor?.framesUsed ?? '—'}`}
            </pre>

            <div className="breath-buttons">
              <button type="button" className="breath-button" onClick={reopen}>
                Recalibrate
              </button>
              <button type="button" className="breath-button" onClick={copyDiagnostics}>
                {copied ? 'Copied' : 'Copy diagnostics'}
              </button>
            </div>
          </div>

          <div className="breath-section">
            <button
              type="button"
              className="breath-button"
              aria-expanded={tuning}
              onClick={() => setTuning((t) => !t)}
            >
              {tuning ? 'Hide thresholds' : 'Tune thresholds'}
            </button>
            {tuning && (
              <div className="breath-sliders">
                <label className="breath-slider">
                  <span>leak lag ms</span>
                  <input
                    type="range" min={0} max={120} step={1} value={lagMs}
                    onChange={(e) => setLagMs(Number(e.target.value))}
                  />
                  <output>{lagMs}</output>
                </label>
                {SLIDERS.map((s) => (
                  <label key={s.key} className="breath-slider">
                    <span>{s.label}</span>
                    <input
                      type="range"
                      min={s.min}
                      max={s.max}
                      step={s.step}
                      value={config[s.key]}
                      onChange={(e) =>
                        setConfig((c) => ({ ...c, [s.key]: Number(e.target.value) }))}
                    />
                    <output>{config[s.key]}</output>
                  </label>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One sentence per cause, and every one of them says what is actually true.
 * `never-triggered` is deliberately absent — it is not a failure and is
 * reported by the detection chip instead.
 */
const FAILURE_TEXT: Record<string, string> = {
  permissionDenied: 'The microphone was refused. On iOS this has to be changed in Settings, not here.',
  noDevice: 'No microphone was found on this device.',
  deviceBusy: 'Something else is using the microphone — another tab, or another app.',
  constraintsRejected: 'This combination of processing constraints was refused by the browser.',
  trackArrivedDead: 'The microphone opened and was already closed. Nothing was captured.',
  insecureContext: 'The microphone needs HTTPS. A LAN address is not a secure context — use a tunnel.',
  silentGraph: 'The microphone opened and never delivered a single sample. That is not a quiet room.',
  noFrames: 'The page stopped being drawn, so nothing could be measured.',
  roomTooLoud: 'This room is too loud for a relative threshold to have any headroom.',
  roomUnstable: 'The level in this room swings too much to measure a floor. Wait and try again.',
  trackDrowningMic: 'The track is louder at the microphone than a breath can be. Turn it down, or use headphones.',
  trackMuted: 'iOS took the microphone away mid-session.',
  trackEnded: 'The microphone track ended mid-session.',
  contextInterrupted: 'The audio session was interrupted — a call, or Siri.',
  captureLost: 'Frames are still arriving and the audio has stopped. We stopped hearing; this is not you.',
};
