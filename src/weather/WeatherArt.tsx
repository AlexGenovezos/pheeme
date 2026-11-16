// Drawn weather: a small SVG scene per kind. Clouds are clusters of shaded spheres, laid out
// from a seed (the day), so each day's sky differs but redraws the same; the sun is a warm disc
// with a glow; rain and snow are particles, more of them the heavier it falls; a storm's bolt
// flickers under a dark cloud. The parts move (clouds bob and drift, rain and snow fall, the sun
// glows) while `motion` allows it; otherwise it's a still picture (weather.css).
import { type CSSProperties, useId } from "react";
import { cx } from "../lib/utils";
import type { Intensity, WeatherKind } from "./codes";

/** A seeded random number generator (FNV-1a hash into mulberry32): the same seed, the same sky. */
export function random(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
/** A part's place in its animation cycle, so the parts don't move in step. */
const phase = (i: number, p: number) => ({ "--wx-i": i, "--wx-p": p }) as CSSProperties;

interface Puff {
  x: number;
  y: number;
  r: number;
}

/** A cloud `width` wide whose bottom sits at `y`: one or two big puffs behind a row of smaller ones. */
function puffs(rand: Rand, x: number, y: number, width: number): Puff[] {
  const row = 3 + Math.floor(rand() * 2);
  const out: Puff[] = [];
  const big = width * (0.27 + rand() * 0.06);
  out.push({ x: x + (rand() - 0.6) * width * 0.2, y: y - big * 1.15, r: big });
  if (rand() > 0.35) {
    const r = width * (0.18 + rand() * 0.05);
    out.push({ x: x + width * (0.18 + rand() * 0.08), y: y - r * 1.2, r });
  }
  for (let i = 0; i < row; i++) {
    const r = (width / row) * (0.62 + rand() * 0.16);
    const cx = x - width / 2 + ((i + 0.5) * width) / row + (rand() - 0.5) * 1.2;
    out.push({ x: cx, y: y - r, r });
  }
  return out;
}

function Cloud({
  rand,
  x,
  y,
  width,
  ids,
  tone,
}: {
  rand: Rand;
  x: number;
  y: number;
  width: number;
  /** The drawing's gradient id prefix. */
  ids: string;
  tone?: "back" | "storm";
}) {
  const list = puffs(rand, x, y, width);
  const fill = `url(#${ids}${tone === "back" ? "b" : tone === "storm" ? "t" : "s"})`;
  return (
    <g className={cx("wx-cloud", tone && `wx-cloud--${tone}`)}>
      <ellipse className="wx-cloud__shadow" cx={x} cy={y + 1.2} rx={width * 0.42} ry={0.9} />
      <g className="wx-drift" style={phase(0, rand())}>
        {list.map((p, i) => (
          <circle
            key={i}
            className="wx-puff"
            style={phase(i, rand())}
            cx={p.x}
            cy={p.y}
            r={p.r}
            fill={fill}
          />
        ))}
      </g>
    </g>
  );
}

function Sun({ x, y, r, fill }: { x: number; y: number; r: number; fill: string }) {
  return (
    <g className="wx-sun">
      <circle className="wx-sun__glow" cx={x} cy={y} r={r * 1.45} />
      <circle cx={x} cy={y} r={r} fill={fill} />
    </g>
  );
}

/** Rain or snow under a cloud spanning `from`–`to` across, falling from `top`. */
function Fall({
  rand,
  kind,
  count,
  from,
  to,
  top,
}: {
  rand: Rand;
  kind: "rain" | "snow";
  count: number;
  from: number;
  to: number;
  top: number;
}) {
  return (
    <g className={`wx-fall wx-fall--${kind}`}>
      {Array.from({ length: count }, (_, i) => {
        const x = from + rand() * (to - from);
        const y = top + rand() * 2;
        const style = phase(i, rand());
        if (kind === "snow")
          return (
            <circle
              key={i}
              className="wx-flake"
              style={style}
              cx={x}
              cy={y}
              r={0.7 + rand() * 0.5}
            />
          );
        const length = 2.2 + rand() * 2;
        return (
          <line
            key={i}
            className="wx-drop"
            style={style}
            x1={x}
            y1={y}
            x2={x - length * 0.25}
            y2={y + length}
          />
        );
      })}
    </g>
  );
}

const FALL_COUNT = { 1: [5, 4], 2: [9, 7], 3: [15, 11] } as const;

export function WeatherArt({
  kind,
  intensity = 2,
  seed,
  motion = "still",
  className,
}: {
  kind: WeatherKind;
  intensity?: Intensity;
  /** Lays out the clouds and the rain: the day it shows, so a day looks the same every time. */
  seed: string;
  /** `live` moves all the time, `hover` while its day's forecast is pointed at, `still` never. */
  motion?: "live" | "hover" | "still";
  className?: string;
}) {
  // Gradient ids for this drawing (useId's colons aren't safe in `url(#…)`).
  const id = `wx${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const sun = `url(#${id}u)`;
  const rand = random(`${seed}|${kind}`);
  const [drops, flakes] = FALL_COUNT[intensity];

  let scene;
  switch (kind) {
    case "clear":
      scene = <Sun x={16} y={16} r={7.5} fill={sun} />;
      break;
    case "partly":
      scene = (
        <>
          <Sun x={11.5} y={11.5} r={6} fill={sun} />
          <Cloud rand={rand} x={18.5} y={25.5} width={17} ids={id} />
        </>
      );
      break;
    case "cloudy":
      scene = (
        <>
          <Cloud rand={rand} x={12} y={17.5} width={13} ids={id} tone="back" />
          <Cloud rand={rand} x={18} y={26} width={19} ids={id} />
        </>
      );
      break;
    case "fog":
      scene = (
        <>
          <Cloud rand={rand} x={16} y={19} width={18} ids={id} tone="back" />
          <g className="wx-fog">
            {[22, 25.5, 29].map((y, i) => (
              <rect
                key={y}
                className="wx-band"
                style={phase(i, rand())}
                x={5 + i * 1.5}
                y={y - 0.9}
                width={22 - i * 3}
                height={1.8}
                rx={0.9}
              />
            ))}
          </g>
        </>
      );
      break;
    case "drizzle":
    case "rain":
    case "snow":
      scene = (
        <>
          <Cloud rand={rand} x={16} y={19} width={20} ids={id} />
          <Fall
            rand={rand}
            kind={kind === "snow" ? "snow" : "rain"}
            count={kind === "snow" ? flakes : kind === "drizzle" ? Math.max(4, drops - 3) : drops}
            from={8}
            to={25}
            top={20}
          />
        </>
      );
      break;
    case "storm":
      scene = (
        <>
          <Fall rand={rand} kind="rain" count={drops} from={8} to={25} top={20} />
          <path className="wx-bolt" d="M16.6 19.5 L14.6 23.6 L17 24 L14.6 28.6 M15.6 26.6 L18 28" />
          <Cloud rand={rand} x={16} y={20} width={21} ids={id} tone="storm" />
        </>
      );
      break;
  }

  // Framed a little inside the 32-unit drawing, so it fills small slots.
  return (
    <svg
      className={cx("weather-art", `weather-art--${motion}`, className)}
      viewBox="3 3 26 26"
      aria-hidden="true"
      data-kind={kind}
      data-intensity={intensity}
    >
      <defs>
        {/* Spheres lit from the upper left: a highlight, the body, then the shaded underside. */}
        {(["s", "b", "t"] as const).map((tone) => (
          <radialGradient
            key={tone}
            id={`${id}${tone}`}
            className={`wx-shade wx-shade--${tone}`}
            cx="0.36"
            cy="0.3"
            r="0.78"
          >
            <stop offset="0" className="wx-stop-light" />
            <stop offset="0.55" className="wx-stop-mid" />
            <stop offset="1" className="wx-stop-dark" />
          </radialGradient>
        ))}
        <radialGradient id={`${id}u`} cx="0.38" cy="0.34" r="0.75">
          <stop offset="0" className="wx-stop-sun-light" />
          <stop offset="1" className="wx-stop-sun-deep" />
        </radialGradient>
      </defs>
      {scene}
    </svg>
  );
}
