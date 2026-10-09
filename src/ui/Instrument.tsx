import { useEffect, useRef } from 'react';
import type { DetectorConfig } from '../detect/config';
import type { Live } from '../useBreathDetector';

/**
 * The tuning surface — and the thing this spike is actually for.
 *
 * ── WHY THE HISTORY STRIP IS THE MOST IMPORTANT WIDGET HERE ────────────────
 * During a breath the phone is under the chin, where the tester can read
 * nothing at all. They read AFTERWARDS, at arm's length. So nothing live is
 * readable while breathing, and the only thing that can answer "what did that
 * one look like?" is a strip of recent history. With no recording path in this
 * spike, it is the whole of the evidence.
 *
 * Everything is drawn on one canvas from one rAF loop, and the numerals are
 * written to DOM refs at 10 Hz. A number changing at 60–120 Hz is illegible
 * anyway, and putting it through React state would jitter rAF and corrupt the
 * `dt` the detector smooths with.
 */

const HISTORY_SECONDS = 8;
const HISTORY_SAMPLES = 480;

type Row = { key: string; label: string; min: number; max: number };

const ROWS: readonly Row[] = [
  { key: 'excess', label: 'excess', min: 0, max: 40 },
  { key: 'low', label: 'low', min: 0, max: 1 },
  { key: 'high', label: 'high', min: 0, max: 1 },
  { key: 'flat', label: 'flat', min: -40, max: 0 },
];

export function Instrument({
  live,
  config,
}: {
  live: React.RefObject<Live>;
  config: DetectorConfig;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    /* Ring buffers. NaN marks a frame with no shape evidence. */
    const excess = new Float32Array(HISTORY_SAMPLES).fill(NaN);
    const level = new Float32Array(HISTORY_SAMPLES).fill(NaN);
    const breathing = new Uint8Array(HISTORY_SAMPLES);
    const blocked = new Uint8Array(HISTORY_SAMPLES);
    let head = 0;
    let lastPush = performance.now();
    let lastText = 0;
    let raf = 0;
    let width = 0;
    let height = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const pushInterval = (HISTORY_SECONDS * 1000) / HISTORY_SAMPLES;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const now = performance.now();
      const snapshot = live.current;
      const frame = snapshot?.frame ?? null;
      const detector = snapshot?.detector;
      const cfg = configRef.current;

      while (now - lastPush >= pushInterval) {
        lastPush += pushInterval;
        excess[head] = frame?.excessDb ?? NaN;
        level[head] = detector?.levelDb ?? NaN;
        breathing[head] = detector?.breathing === true ? 1 : 0;
        blocked[head] = detector?.phase === 'blocked' ? 1 : 0;
        head = (head + 1) % HISTORY_SAMPLES;
      }

      ctx.clearRect(0, 0, width, height);

      /* ── The history strip ─────────────────────────────────────────────── */
      const stripH = Math.min(120, height * 0.45);
      const yFor = (db: number) => stripH - (Math.max(0, Math.min(40, db)) / 40) * stripH;
      const colW = width / HISTORY_SAMPLES;

      /* Shaded periods first, so the traces sit on top of them. */
      for (let i = 0; i < HISTORY_SAMPLES; i += 1) {
        const idx = (head + i) % HISTORY_SAMPLES;
        if (blocked[idx] === 1) {
          ctx.fillStyle = 'rgba(220, 150, 90, 0.22)';
          ctx.fillRect(i * colW, 0, colW + 0.6, stripH);
        } else if (breathing[idx] === 1) {
          ctx.fillStyle = 'rgba(120, 220, 190, 0.16)';
          ctx.fillRect(i * colW, 0, colW + 0.6, stripH);
        }
      }

      /* The two thresholds, as rules you can see the trace cross. */
      for (const [db, colour] of [
        [cfg.onsetExcessDb, 'rgba(255,255,255,0.45)'],
        [cfg.sustainExcessDb, 'rgba(255,255,255,0.2)'],
      ] as const) {
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, yFor(db));
        ctx.lineTo(width, yFor(db));
        ctx.stroke();
      }

      /* Raw excess as a filled area; the smoothed level over it as a line.
         Comparing the two is the best way to judge the attack/release pair. */
      ctx.fillStyle = 'rgba(150, 200, 255, 0.35)';
      ctx.beginPath();
      ctx.moveTo(0, stripH);
      for (let i = 0; i < HISTORY_SAMPLES; i += 1) {
        const v = excess[(head + i) % HISTORY_SAMPLES];
        ctx.lineTo(i * colW, Number.isNaN(v) ? stripH : yFor(v));
      }
      ctx.lineTo(width, stripH);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = 'rgba(150, 230, 210, 0.95)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < HISTORY_SAMPLES; i += 1) {
        const v = level[(head + i) % HISTORY_SAMPLES];
        if (Number.isNaN(v)) continue;
        if (started) ctx.lineTo(i * colW, yFor(v));
        else { ctx.moveTo(i * colW, yFor(v)); started = true; }
      }
      ctx.stroke();

      /* ── The four bars, with their thresholds as ticks ─────────────────── */
      const barTop = stripH + 14;
      const rowH = 26;
      const labelW = 52;
      const barW = width - labelW - 74;

      const values: Record<string, number | null> = {
        excess: frame?.excessDb ?? null,
        low: frame?.shape?.lowRatio ?? null,
        high: frame?.shape?.highRatio ?? null,
        flat: frame?.shape?.flatnessDb ?? null,
      };
      const ticks: Record<string, number[]> = {
        excess: [cfg.sustainExcessDb, cfg.onsetExcessDb],
        low: [cfg.minLowRatio],
        high: [cfg.maxHighRatio],
        flat: [cfg.maxFlatnessDb],
      };
      /* A minimum shades below the tick; a maximum shades above it. */
      const isMinimum: Record<string, boolean> = {
        excess: true, low: true, high: false, flat: true,
      };

      ROWS.forEach((row, i) => {
        const y = barTop + i * rowH;
        const norm = (v: number) =>
          Math.max(0, Math.min(1, (v - row.min) / (row.max - row.min)));

        ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.textBaseline = 'middle';
        ctx.fillText(row.label, 0, y + 8);

        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(labelW, y, barW, 16);

        const tick = ticks[row.key][ticks[row.key].length - 1];
        const tickX = labelW + norm(tick) * barW;
        if (isMinimum[row.key]) {
          ctx.fillStyle = 'rgba(220, 120, 110, 0.14)';
          ctx.fillRect(labelW, y, tickX - labelW, 16);
        } else {
          ctx.fillStyle = 'rgba(220, 120, 110, 0.14)';
          ctx.fillRect(tickX, y, labelW + barW - tickX, 16);
        }

        const v = values[row.key];
        if (v !== null) {
          const passes = isMinimum[row.key] ? v >= tick : v <= tick;
          ctx.fillStyle = passes ? 'rgba(150, 230, 210, 0.9)' : 'rgba(165, 185, 215, 0.7)';
          ctx.fillRect(labelW, y, norm(v) * barW, 16);
        }

        for (const t of ticks[row.key]) {
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          ctx.fillRect(labelW + norm(t) * barW - 1, y - 3, 2, 22);
        }

        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.textAlign = 'right';
        ctx.fillText(v === null ? '—' : v.toFixed(2), width, y + 8);
        ctx.textAlign = 'left';
      });

      /* ── Numerals at 10 Hz, because 60 Hz digits are unreadable ────────── */
      if (now - lastText >= 100 && textRef.current !== null) {
        lastText = now;
        const d = snapshot?.detector;
        textRef.current.textContent =
          `phase ${d?.phase ?? '—'}  ·  breaths ${d?.completed ?? 0}` +
          `  ·  last ${d?.lastDurationMs === null || d?.lastDurationMs === undefined ? '—' : `${Math.round(d.lastDurationMs)}ms`}` +
          `  ·  intensity ${(d?.intensity ?? 0).toFixed(2)}` +
          `  ·  ${snapshot?.fps ?? 0} fps`;
      }
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [live]);

  return (
    <div className="breath-instrument">
      <canvas ref={canvasRef} className="breath-instrument-canvas" aria-hidden="true" />
      <div ref={textRef} className="breath-readout" role="status" aria-live="off" />
    </div>
  );
}
