/**
 * The particle simulation. Pure: no canvas, no React, no clock.
 *
 * The emitter sits low and centre, where the phone is relative to the face,
 * and pushes motes outward and upward. `intensity` drives emission rate,
 * launch speed and a global drift.
 */

export type Mote = {
  x: number; y: number;
  vx: number; vy: number;
  life: number;   // 1 at birth, 0 at death
  size: number;
  seed: number;
};

export type Field = {
  motes: Mote[];
  /** Carried between frames so emission is not quantised to whole frames. */
  pending: number;
};

export const MOTE_COUNT = 250;

export function createField(): Field {
  return {
    motes: Array.from({ length: MOTE_COUNT }, () => ({
      x: 0, y: 0, vx: 0, vy: 0, life: 0, size: 0, seed: Math.random(),
    })),
    pending: 0,
  };
}

function launch(mote: Mote, intensity: number, width: number, height: number): void {
  /* Emitter: bottom centre, with a little spread so it is not a point source. */
  mote.x = width * (0.5 + (Math.random() - 0.5) * 0.12);
  mote.y = height * 0.96;

  /* Upward and outward. A stronger exhale launches faster and narrower,
     which is what a faster jet of air actually does. */
  const spread = 1.1 - intensity * 0.45;
  const angle = -Math.PI / 2 + (Math.random() - 0.5) * spread;
  const speed = (0.05 + intensity * 0.55) * height * (0.6 + Math.random() * 0.7);

  mote.vx = Math.cos(angle) * speed;
  mote.vy = Math.sin(angle) * speed;
  mote.life = 1;
  mote.size = 1 + Math.random() * 2.5 + intensity * 2;
  mote.seed = Math.random();
}

/**
 * One step. `dt` in seconds.
 *
 * At intensity 0 the field keeps drifting rather than stopping dead, so the
 * screen stays alive and entering an exhale reads as ACCELERATION rather than
 * as something switching on.
 */
export function stepField(
  field: Field,
  intensity: number,
  dt: number,
  width: number,
  height: number,
  reducedMotion: boolean,
): void {
  const perSecond = 8 + intensity * 150;
  field.pending += perSecond * dt;

  for (const mote of field.motes) {
    if (mote.life <= 0) {
      if (field.pending >= 1) {
        field.pending -= 1;
        launch(mote, intensity, width, height);
      }
      continue;
    }

    if (!reducedMotion) {
      mote.x += mote.vx * dt;
      mote.y += mote.vy * dt;
      /* Drag, so motes decelerate into a drift instead of flying off. */
      const drag = Math.pow(0.12, dt);
      mote.vx *= drag;
      mote.vy *= drag;
      /* A slight rise even once drag has eaten the launch velocity. */
      mote.vy -= height * 0.04 * dt;
      /* Lateral wander, so the plume breathes rather than marching. */
      mote.vx += Math.sin(mote.seed * 31 + mote.y * 0.01) * width * 0.05 * dt;
    }

    mote.life -= dt * (0.45 + (1 - intensity) * 0.35);
    if (mote.x < -50 || mote.x > width + 50 || mote.y < -50) mote.life = 0;
  }
}
