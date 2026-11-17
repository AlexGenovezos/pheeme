// What every scene on the window pane draws with: the theme's weather colours, read from the
// tokens, and the sprites stamped many times a frame (a drop of water, a soft dot).

export type RGB = [number, number, number];

export const rgba = ([r, g, b]: RGB, a: number) => `rgba(${r}, ${g}, ${b}, ${a})`;

/** A token's colour: `#rgb`, `#rrggbb` or `rgb(…)`; black when it can't be read. */
export function parseColor(css: string): RGB {
  const value = css.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as RGB;
  }
  const [r = 0, g = 0, b = 0] = value.match(/[\d.]+/g)?.map(Number) ?? [];
  return [r, g, b];
}

/** The theme's colours for the weather on the pane. */
export interface Ink {
  water: RGB;
  /** Light caught by water and glass. */
  shine: RGB;
  /** The shade water casts on the glass. */
  shade: RGB;
  snow: RGB;
  sun: RGB;
  sunGlow: RGB;
  fog: RGB;
  bolt: RGB;
}

const TOKENS: Record<keyof Ink, string> = {
  water: "--weather-rain",
  shine: "--weather-glass-shine",
  shade: "--weather-glass-shade",
  snow: "--weather-snow",
  sun: "--weather-sun-light",
  sunGlow: "--weather-sun-glow",
  fog: "--weather-fog",
  bolt: "--weather-bolt",
};

export function readInk(el: Element): Ink {
  const cs = getComputedStyle(el);
  return Object.fromEntries(
    Object.entries(TOKENS).map(([key, token]) => [key, parseColor(cs.getPropertyValue(token))]),
  ) as unknown as Ink;
}

function sprite(size: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  if (ctx) draw(ctx);
  return c;
}

/** The drop sprite's size and the drop's radius in it, px; the rest is room for its shadow. */
const DROP = 64;
const DROP_R = 22;
/** Scales a drop's radius to the size its sprite is stamped at. */
export const DROP_SCALE = DROP / DROP_R;

/**
 * One drop of water on glass, stamped at every size: a clear lens, light caught in its lower
 * edge (a drop turns the light above it upside down), a dark upper rim, a glint and a soft
 * shadow on the glass below it.
 */
export function dropSprite({ water, shine, shade }: Ink): HTMLCanvasElement {
  return sprite(DROP, (ctx) => {
    const m = DROP / 2;
    const R = DROP_R;
    const fill = (g: CanvasGradient) => {
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, DROP, DROP);
    };
    const shadow = ctx.createRadialGradient(
      m + 1,
      m + R * 0.22,
      R * 0.6,
      m + 1,
      m + R * 0.22,
      R * 1.3,
    );
    shadow.addColorStop(0, rgba(shade, 0.32));
    shadow.addColorStop(1, rgba(shade, 0));
    fill(shadow);

    ctx.save();
    ctx.beginPath();
    ctx.arc(m, m, R, 0, Math.PI * 2);
    ctx.clip();
    const body = ctx.createRadialGradient(m, m + R * 0.2, 0, m, m, R);
    body.addColorStop(0, rgba(water, 0.06));
    body.addColorStop(0.65, rgba(water, 0.16));
    body.addColorStop(1, rgba(water, 0.42));
    fill(body);
    const caught = ctx.createRadialGradient(m, m + R * 0.75, 0, m, m + R * 0.75, R * 0.85);
    caught.addColorStop(0, rgba(shine, 0.5));
    caught.addColorStop(1, rgba(shine, 0));
    fill(caught);
    const rim = ctx.createRadialGradient(m, m + R * 0.35, R * 0.75, m, m + R * 0.35, R * 1.35);
    rim.addColorStop(0, rgba(shade, 0));
    rim.addColorStop(1, rgba(shade, 0.55));
    fill(rim);
    ctx.restore();

    const gx = m - R * 0.36;
    const gy = m - R * 0.4;
    const glint = ctx.createRadialGradient(gx, gy, 0, gx, gy, R * 0.26);
    glint.addColorStop(0, rgba(shine, 0.95));
    glint.addColorStop(0.5, rgba(shine, 0.4));
    glint.addColorStop(1, rgba(shine, 0));
    fill(glint);
  });
}

/** A soft round dot of `color`, opaque in the middle and fading out by its edge (`hardness` 0–1). */
export function dotSprite(color: RGB, hardness = 0.3): HTMLCanvasElement {
  const size = 64;
  return sprite(size, (ctx) => {
    const m = size / 2;
    const g = ctx.createRadialGradient(m, m, 0, m, m, m);
    g.addColorStop(0, rgba(color, 1));
    g.addColorStop(hardness, rgba(color, 0.85));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  });
}

/** Stamps `img` centred on x, y, `w` by `h` (square when `h` is left out). */
export function stamp(
  ctx: CanvasRenderingContext2D,
  img: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h = w,
) {
  ctx.drawImage(img, x - w / 2, y - h / 2, w, h);
}

/** Eases `value` toward `target`, most of the way in about `seconds`. */
export function ease(value: number, target: number, dt: number, seconds: number): number {
  const next = value + (target - value) * (1 - Math.exp((-dt * 3) / seconds));
  return Math.abs(next - target) < 0.005 ? target : next;
}
