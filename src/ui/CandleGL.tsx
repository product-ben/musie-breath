import { useEffect, useRef, useState } from 'react';
import type { Live } from '../useBreathDetector';
import { DEFAULT_CANDLE, initialCandle, isOverdriven, nextCandle } from './candle';
import type { CandleState } from './candle';
import { FRAGMENT_SRC, VERTEX_SRC } from './candleShader';

/**
 * The candle, in WebGL.
 *
 * This component owns the GL context, the rAF loop and nothing else. Every
 * number it uploads comes from candle.ts, which is pure and tested — so the
 * flame can never disagree with the decision that drove it, and the part that
 * can only be judged by looking at it contains no logic to get wrong.
 *
 * It reads `live` out of a ref inside its own loop rather than through props,
 * because a 60–120 Hz React render would jitter rAF and `dt` is what every
 * smoothing coefficient here derives from.
 */

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (shader === null) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  /**
   * Truthiness, NOT `!== true`. The spec says GLboolean and some
   * implementations hand back 1 rather than true, which made a perfectly good
   * shader — including the four-line vertex one — report as failed with a null
   * info log, i.e. the most confusing possible symptom.
   */
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    /* Logged rather than swallowed: a shader that fails to compile otherwise
       shows up as a black rectangle with no explanation anywhere. */
    console.error('candle shader:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

type Program = {
  program: WebGLProgram;
  buffer: WebGLBuffer;
  u: Record<string, WebGLUniformLocation | null>;
};

function build(gl: WebGLRenderingContext): Program | null {
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SRC);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
  if (vs === null || fs === null) return null;

  const program = gl.createProgram();
  if (program === null) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('candle link:', gl.getProgramInfoLog(program));
    return null;
  }

  const buffer = gl.createBuffer();
  if (buffer === null) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  /* Two triangles covering clip space. The whole scene is the fragment stage. */
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const aPos = gl.getAttribLocation(program, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const names = ['uRes', 'uTime', 'uLife', 'uLean', 'uTurb', 'uSmoke', 'uFlare', 'uWander'];
  const u: Record<string, WebGLUniformLocation | null> = {};
  for (const n of names) u[n] = gl.getUniformLocation(program, n);

  return { program, buffer, u };
}

export function CandleGL({
  live,
  onCandle,
}: {
  live: React.RefObject<Live>;
  /** So the readout can show what the flame is doing. Throttled by the caller. */
  onCandle?: (state: CandleState) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const onCandleRef = useRef(onCandle);
  onCandleRef.current = onCandle;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let gl: WebGLRenderingContext | null = null;
    let prog: Program | null = null;
    let raf = 0;
    let lost = false;

    const init = (): boolean => {
      const opts = { antialias: false, alpha: false, depth: false };
      const ctx: unknown =
        canvas.getContext('webgl', opts) ?? canvas.getContext('experimental-webgl', opts);
      gl = ctx === null ? null : (ctx as WebGLRenderingContext);
      if (gl === null) return false;
      prog = build(gl);
      if (prog === null) return false;
      gl.useProgram(prog.program);
      return true;
    };

    if (!init()) {
      setFailed(true);
      return;
    }

    /**
     * iOS discards GL contexts under memory pressure, and a lost context that
     * is never rebuilt is a permanently black screen. preventDefault is what
     * makes the restore event fire at all.
     */
    const onLost = (e: Event) => {
      e.preventDefault();
      lost = true;
      cancelAnimationFrame(raf);
    };
    const onRestored = () => {
      lost = false;
      if (init()) {
        resize();
        raf = requestAnimationFrame(draw);
      } else {
        setFailed(true);
      }
    };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);

    let width = 0;
    let height = 0;
    const resize = () => {
      /* Capped at 2: a flame is smooth noise and the third device pixel buys
         nothing but fragments, which on a phone is heat and battery. */
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width * dpr));
      height = Math.max(1, Math.round(rect.height * dpr));
      canvas.width = width;
      canvas.height = height;
      gl?.viewport(0, 0, width, height);
    };
    resize();
    window.addEventListener('resize', resize);

    let candle: CandleState = initialCandle();
    let overdrivenFor = 0;
    let wander = 0.4;
    let wanderTarget = 0.4;
    let wanderNext = 0;
    let last = performance.now();
    let reported = 0;

    const draw = () => {
      if (lost) return;
      raf = requestAnimationFrame(draw);
      const now = performance.now();
      const dt = Math.min(100, now - last);
      last = now;

      /**
       * A drive hook, on purpose and documented.
       *
       * Setting `window.__forceBreath = { intensity, peak }` feeds the flame
       * directly. Tuning a visual by breathing at it is slow and unrepeatable
       * — you cannot hold 0.6 steady with your lungs — and a screenshot taken
       * at a known input is the only way to compare two versions of the
       * shader honestly. Delete it and the candle is untunable.
       */
      const forced = (window as unknown as {
        __forceBreath?: { intensity: number; peak: number };
      }).__forceBreath;

      const detector = live.current?.detector;
      const frame = live.current?.frame;
      const intensity = forced?.intensity ?? detector?.intensity ?? 0;
      const peak = forced?.peak ?? frame?.peak ?? 0;

      overdrivenFor = isOverdriven({ intensity, peak }, DEFAULT_CANDLE)
        ? overdrivenFor + dt
        : 0;
      candle = nextCandle(candle, { intensity, peak }, dt, DEFAULT_CANDLE, overdrivenFor);

      /**
       * The direction the flame leans wanders slowly, because a microphone
       * cannot tell which way air was moving and a fixed direction would make
       * every breath look identical. Only the magnitude is measured.
       */
      if (now >= wanderNext) {
        wanderTarget = (Math.random() * 2 - 1) * 0.9;
        wanderNext = now + 900 + Math.random() * 1600;
      }
      wander += (wanderTarget - wander) * (1 - Math.exp(-dt / 600));

      if (gl === null || prog === null) return;
      gl.uniform2f(prog.u.uRes, width, height);
      /* Frozen clock under reduced motion: the flame still responds in size
         and brightness, and nothing churns on its own. */
      gl.uniform1f(prog.u.uTime, reducedMotion ? 0 : now / 1000);
      gl.uniform1f(prog.u.uLife, candle.life);
      gl.uniform1f(prog.u.uLean, reducedMotion ? 0 : candle.lean);
      gl.uniform1f(prog.u.uTurb, reducedMotion ? 0 : candle.turbulence);
      gl.uniform1f(prog.u.uSmoke, candle.smoke);
      gl.uniform1f(prog.u.uFlare, candle.flare);
      gl.uniform1f(prog.u.uWander, reducedMotion ? 0 : wander);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      /* 8 Hz is plenty for a text readout and costs eight renders a second
         instead of a hundred and twenty. */
      if (now - reported > 125) {
        reported = now;
        onCandleRef.current?.(candle);
      }
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      if (gl !== null && prog !== null) {
        gl.deleteBuffer(prog.buffer);
        gl.deleteProgram(prog.program);
      }
      /**
       * ── DO NOT CALL loseContext() HERE ──────────────────────────────────
       * It looks like good hygiene — hand the GPU memory back rather than
       * waiting for the collector — and it poisons the canvas.
       *
       * getContext on a canvas returns the SAME context object every time, so
       * a context deliberately lost on teardown is handed straight back to the
       * next mount, already dead. Every shader then "fails" to compile with a
       * null info log, which is the most confusing symptom available: the
       * source is fine and the log is empty.
       *
       * React 19 StrictMode double-mounts effects on the same DOM node, so
       * this fired on the very first render in development and the candle
       * never appeared once. The context dies with the canvas; deleting the
       * program and buffer above is all that is owed.
       */
    };
  }, [live]);

  if (failed) {
    return (
      <div className="breath-gl-failed">
        WebGL is unavailable, so there is no candle. Detection is unaffected —
        the numbers below are the measurement.
      </div>
    );
  }
  return <canvas ref={canvasRef} className="breath-canvas" aria-hidden="true" />;
}
