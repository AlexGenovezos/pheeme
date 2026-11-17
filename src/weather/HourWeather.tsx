// The weather in a day's hours (Day and Week): one soft band per run behind the events, each
// seen as if through a window pane (pane/): rain on the glass, lightning, snow falling outside,
// fog and condensation, sunlight. Still pictures; they move only while their day plays
// (motion.ts), and wind down by themselves when it stops.
import { cx } from "../lib/utils";
import { type HourRun } from "./hourly";
import { Pane } from "./pane/Pane";
import "./weather.css";

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
      <div className="wx-hours__sheen" />
      <Pane
        kind={run.kind}
        seed={`${seed}|${run.start}`}
        intensity={run.intensity}
        playing={playing}
      />
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
