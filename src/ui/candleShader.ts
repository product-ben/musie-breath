/**
 * The candle, as one fragment shader.
 *
 * Everything — wax, wick, flame, glow, smoke — is signed-distance work in a
 * single full-screen pass. No geometry, no textures, no dependency, one draw
 * call. GLSL ES 1.00 rather than 3.00 because WebGL1 is available everywhere
 * iOS has ever been and nothing here needs a WebGL2 feature.
 *
 * All motion comes from uniforms the pure state machine in candle.ts produces,
 * so what is drawn can never disagree with what was decided.
 */

export const VERTEX_SRC = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

export const FRAGMENT_SRC = `
precision highp float;

uniform vec2  uRes;
uniform float uTime;
uniform float uLife;    // 0..1 how much flame there is
uniform float uLean;    // 0..1 how hard it is pushed over
uniform float uTurb;    // 0..1 how violently it churns
uniform float uSmoke;   // 0..1 smoke after a blowout
uniform float uFlare;   // 0..1 brief flare as it catches
uniform float uWander;  // -1..1 slow drift, so the push has a direction

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

/* Where the wick ends and the flame begins. */
const float WICK_Y  = -0.06;
const float BODY_W  = 0.072;
const float BODY_BOT = -0.58;

void main() {
  /* Aspect-correct, y up, origin at the middle. Dividing both axes by height
     keeps the candle the same shape whatever the window does. */
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;

  vec3 col = vec3(0.0);

  /* ── The flame ──────────────────────────────────────────────────────────
     A teardrop whose radius is zero at the wick and zero at the tip, widest
     about a third of the way up. Taller and thinner the harder it is blown,
     which is what a real flame does in a draught. */
  /* A candle flame is roughly three times as tall as it is wide. Taller than
     that and it stops reading as a flame however good the motion is. */
  float height = (0.235 + 0.055 * uLean + 0.04 * uFlare) * max(uLife, 0.0);
  float t = clamp((uv.y - WICK_Y) / max(height, 1e-4), 0.0, 1.0);

  /* Barely narrows with the wind. Thinning it as well as leaning it turned
     the flame into a ribbon at mid intensity and lost the teardrop entirely. */
  float width = BODY_W * (1.55 - 0.16 * uLean);
  float radius = width * pow(t, 0.40) * (1.0 - t);

  /* Turbulence scrolls upward and bites harder near the tip, where a flame
     has least to hold it together. */
  float churn = fbm(vec2(uv.x * 7.0, uv.y * 5.0 - uTime * 1.9)) - 0.5;
  /**
   * pow(t, 2.1), not 1.3: a real flame is ANCHORED AT ITS BASE and only the
   * upper half whips about. Spreading the displacement evenly made the whole
   * shape slide sideways and read as a streamer rather than as a flame being
   * blown.
   */
  float sway = churn * (0.035 + 0.26 * uTurb) * pow(t, 2.1);

  /* Lean is signed by uWander, because NOTHING IN A MICROPHONE SAYS WHICH WAY
     the air was moving. Inventing a direction from the level would be a lie
     told in pixels, so the direction drifts and only the magnitude is real. */
  float lean = uLean * uWander * 0.26 * pow(t, 2.1);

  float x = uv.x - sway - lean;
  float d = abs(x) - radius;

  float edge = 0.004 + 0.012 * uTurb;
  float flame = smoothstep(edge, -edge, d) * step(0.0001, t) * step(t, 0.9999);
  flame *= smoothstep(0.0, 0.08, uLife);

  /* Colour by depth into the flame and by height: a blue-white base, a yellow
     body, an orange tip that frays. */
  float core = smoothstep(0.0, -0.055 * (1.0 - 0.4 * t), d);
  vec3 tip  = vec3(1.00, 0.42, 0.10);
  vec3 body = vec3(1.00, 0.84, 0.36);
  vec3 base = vec3(0.62, 0.80, 1.00);
  vec3 flameCol = mix(tip, body, core);
  flameCol = mix(flameCol, base, core * smoothstep(0.30, 0.0, t) * 0.85);
  flameCol += vec3(0.9, 0.5, 0.2) * uFlare * 0.6;

  /**
   * HEAT, NOT BRIGHTNESS. The core is pushed far above 1.0 so that the tone
   * map below lands it on white-hot; multiplying by something near 1 produced
   * a flat yellow shape that looked painted on rather than lit. A flame is the
   * light source in this picture and has to be clipped to read as one.
   */
  float heat = 0.85 + 18.0 * pow(core, 1.9) + 2.4 * core;
  col += flameCol * flame * heat;

  /* ── Glow ───────────────────────────────────────────────────────────────
     Two falloffs: a tight halo that reads as brightness, and a wide one that
     lights the room. Both die with the flame. */
  vec2 g = vec2(uv.x - lean * 0.4, uv.y - WICK_Y - height * 0.45);
  float tight = exp(-length(vec2(g.x * 2.4, g.y * 1.6)) * 8.0);
  /* Falls off fast on purpose. A broad halo lifts the whole frame to brown
     and the dark has to stay dark, or nothing else reads as bright. */
  float wide  = exp(-length(vec2(g.x * 1.2, g.y * 0.95)) * 5.0);
  float flicker = 0.88 + 0.12 * (fbm(vec2(uTime * 2.4, 0.0)) - 0.5) * 2.0;
  col += vec3(1.00, 0.58, 0.22) * (tight * 2.60 + wide * 0.30)
       * uLife * flicker * (1.0 + 0.6 * uFlare);

  /* ── Smoke ──────────────────────────────────────────────────────────────
     Only after a blowout, rising and spreading as it goes. This is what makes
     going out read as an event rather than as a dimmer. */
  if (uSmoke > 0.001) {
    float sy = (uv.y - WICK_Y) / 0.75;
    float spread = 0.03 + sy * 0.10;
    float drift = (fbm(vec2(uv.y * 3.0 - uTime * 1.1, uTime * 0.3)) - 0.5) * 0.22 * sy;
    float wisp = fbm(vec2(uv.x * 9.0, uv.y * 6.0 - uTime * 1.4));
    float band = smoothstep(spread, 0.0, abs(uv.x - drift - uWander * sy * 0.05));
    float rise = smoothstep(0.0, 0.12, sy) * smoothstep(1.0, 0.25, sy);
    col += vec3(0.42, 0.44, 0.50) * band * rise * wisp * uSmoke * 0.55;
  }

  /* ── The wax ────────────────────────────────────────────────────────────
     A soft-edged column, lit from the flame above so the blowout is visible
     on the candle itself and not only where the flame was. */
  float bodyX = smoothstep(BODY_W, BODY_W - 0.012, abs(uv.x));
  float bodyY = smoothstep(BODY_BOT - 0.01, BODY_BOT + 0.01, uv.y)
              * smoothstep(WICK_Y, WICK_Y - 0.022, uv.y);
  float body2 = bodyX * bodyY;

  float down = smoothstep(WICK_Y - 0.55, WICK_Y, uv.y);
  vec3 wax = mix(vec3(0.05, 0.045, 0.04), vec3(0.62, 0.57, 0.48), 0.10 + 0.90 * down);

  /**
   * The flame has to light the wax, or the blowout is only visible where the
   * flame was. This is the term that makes the whole candle go dark when it
   * goes out, which is what sells it.
   */
  float pool = pow(down, 3.0);
  wax *= 0.12 + 0.88 * (0.10 + 0.90 * pool * (0.12 + 0.88 * uLife));
  wax += vec3(1.0, 0.50, 0.16) * pool * uLife * 1.9;
  /* Translucent wax: light creeps a little way down the column. */
  wax += vec3(0.85, 0.34, 0.09) * pow(down, 1.4) * uLife * 0.30;
  /* A cool rim, so the column has a shape at all against the dark. */
  wax *= 0.80 + 0.20 * smoothstep(BODY_W, 0.0, abs(uv.x));
  wax += vec3(0.16, 0.19, 0.26) * smoothstep(BODY_W - 0.014, BODY_W, abs(uv.x)) * 0.5;
  col = mix(col, wax + col * 0.3, body2);

  /* A molten rim right at the top, which only glows while it is lit. */
  float rim = smoothstep(0.02, 0.0, abs(uv.y - (WICK_Y - 0.012))) * bodyX;
  col += vec3(1.0, 0.56, 0.20) * rim * uLife * 1.6;

  /* The wick: dark while lit, and briefly orange at the very tip. */
  float wick = smoothstep(0.0075, 0.0, abs(uv.x))
             * smoothstep(WICK_Y - 0.035, WICK_Y - 0.03, uv.y)
             * smoothstep(WICK_Y + 0.012, WICK_Y - 0.004, uv.y);
  col = mix(col, vec3(0.08, 0.07, 0.07), wick * 0.9);
  col += vec3(1.0, 0.35, 0.08) * wick * (uLife * 0.5 + uSmoke * 0.25);

  /* A very slight vignette, so the dark is not flat. */
  col *= 1.0 - 0.42 * smoothstep(0.1, 1.05, length(uv * vec2(0.85, 0.70)));

  /* Tone map, then a touch of gamma, so the core reads as white-hot rather
     than as clipped yellow. */
  /* Reinhard, then a gentle gamma. With the heat term above, the core lands
     at white and everything else keeps its colour instead of washing out. */
  col = col / (col + vec3(1.0));
  col = pow(max(col, 0.0), vec3(0.82));

  gl_FragColor = vec4(col, 1.0);
}
`;
