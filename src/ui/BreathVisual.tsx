import { useEffect, useRef } from 'react';
import type { Live } from '../useBreathDetector';
import { createField, stepField } from './field';

/**
 * The biofeedback half. Reads `live` inside its own rAF loop, so nothing here
 * costs a React render — see the note in useBreathDetector.
 */
export function BreathVisual({ live }: { live: React.RefObject<Live> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const field = createField();
    let raf = 0;
    let last = performance.now();
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

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      const detector = live.current?.detector;
      const intensity = detector?.intensity ?? 0;
      const breathing = detector?.breathing ?? false;

      stepField(field, intensity, dt, width, height, reducedMotion);

      ctx.clearRect(0, 0, width, height);

      /* A faint ground glow, so intensity is legible even with no motes near. */
      const glow = ctx.createRadialGradient(
        width / 2, height, 0,
        width / 2, height, height * (0.35 + intensity * 0.5),
      );
      glow.addColorStop(0, `rgba(120, 190, 255, ${0.05 + intensity * 0.22})`);
      glow.addColorStop(1, 'rgba(120, 190, 255, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);

      /* `breathing` is shown as hue, intensity as brightness and size. Both
         must be separately visible: the single most diagnostic sight on this
         screen is a high intensity with breathing still false — onset not yet
         held, or blocked. */
      for (const mote of field.motes) {
        if (mote.life <= 0) continue;
        const alpha = mote.life * (reducedMotion ? 0.35 + intensity * 0.5 : 0.75);
        ctx.fillStyle = breathing
          ? `rgba(150, 230, 210, ${alpha})`
          : `rgba(165, 185, 215, ${alpha * 0.6})`;
        ctx.beginPath();
        ctx.arc(mote.x, mote.y, mote.size * (reducedMotion ? 1 + intensity : 1), 0, Math.PI * 2);
        ctx.fill();
      }
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [live]);

  return <canvas ref={canvasRef} className="breath-canvas" aria-hidden="true" />;
}
