// The weather in a day's hours (Day and Week): one soft band per run behind the events, rain
// streaks, snow, a warm wash for sun, fog. Still pictures; a band's texture moves only while
// its day plays (motion.ts), as one layer sliding by one tile, so it loops without a seam.
import { type CSSProperties, useId } from "react";
import { cx } from "../lib/utils";
import { type HourRun } from "./hourly";
import { random } from "./WeatherArt";
import "./weather.css";

/** A falling texture's tile, px: rain is tall and narrow, snow square. */
const TILE = { rain: [28, 56], snow: [44, 44] } as const;
/** Drops or flakes per tile, light to heavy. */
const PER_TILE = { rain: [3, 5, 8], snow: [3, 5, 8] } as const;

/** Rain or snow in a tile, seeded so a day's texture redraws the same. */
function Fall({ kind, run, seed }: { kind: "rain" | "snow"; run: HourRun; seed: string }) {
  const id = `wxh${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [w, h] = TILE[kind];
  const rand = random(`${seed}|${run.start}|${kind}`);
  const count = PER_TILE[kind][run.intensity - 1];
  const parts = Array.from({ length: count }, (_, i) => {
    if (kind === "snow") {
      const r = 1 + rand() * 0.9;
      return (
        <circle
          key={i}
          className="wx-hours__flake"
          cx={r + rand() * (w - 2 * r)}
          cy={r + rand() * (h - 2 * r)}
          r={r}
        />
      );
    }
    const length = 7 + rand() * 6;
    const x = 3 + rand() * (w - 4);
    const y = rand() * (h - length);
    return (
      <line
        key={i}
        className="wx-hours__drop"
        x1={x}
        y1={y}
        x2={x - length * 0.18}
        y2={y + length}
      />
    );
  });
  return (
    <div className="wx-hours__fall" style={{ "--wx-tile": `${h}px` } as CSSProperties}>
      <svg width="100%" height="100%">
        <defs>
          <pattern id={id} width={w} height={h} patternUnits="userSpaceOnUse">
            {parts}
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${id})`} />
      </svg>
    </div>
  );
}

function Band({ run, seed, playing }: { run: HourRun; seed: string; playing: boolean }) {
  // In hours of the grid's --cal-hour-h, like the events beside it.
  const style = {
    top: `calc(var(--cal-hour-h) * ${run.start / 60})`,
    height: `calc(var(--cal-hour-h) * ${(run.end - run.start) / 60})`,
  };
  return (
    <div
      className={cx("wx-hours", `wx-hours--${run.kind}`, playing && "wx-hours--playing")}
      data-intensity={run.intensity}
      style={style}
    >
      {run.kind === "sun" && <div className="wx-hours__glow" />}
      {run.kind === "fog" && <div className="wx-hours__mist" />}
      {(run.kind === "rain" || run.kind === "storm") && <Fall kind="rain" run={run} seed={seed} />}
      {run.kind === "snow" && <Fall kind="snow" run={run} seed={seed} />}
      {run.kind === "storm" && <div className="wx-hours__flash" />}
    </div>
  );
}

/** A day column's bands; nothing when the day has no runs. */
export function HourWeather({
  runs,
  date,
  playing,
}: {
  runs: HourRun[] | undefined;
  date: string;
  playing: boolean;
}) {
  if (!runs?.length) return null;
  return (
    <div className="wx-hours-day" aria-hidden="true" data-date={date}>
      {runs.map((run) => (
        <Band key={`${run.kind}-${run.start}`} run={run} seed={date} playing={playing} />
      ))}
    </div>
  );
}
