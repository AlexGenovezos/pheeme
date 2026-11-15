// Drawn weather: sun, clouds, rain, snow, lightning and fog as one small SVG scene whose parts
// move (rays turn, clouds drift, rain and snow fall, lightning flickers). Still until `live` or,
// in a day's header, until hovered (weather.css), so a calendar full of days doesn't keep the
// GPU awake; reduced motion keeps it still.
import { cx } from "../lib/utils";
import type { WeatherKind } from "./codes";

const RAYS = Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4);

function Sun({ x, y, r }: { x: number; y: number; r: number }) {
  return (
    <g className="wx-sun">
      <g className="wx-rays">
        {RAYS.map((a) => (
          <line
            key={a}
            x1={x + Math.cos(a) * (r + 2.5)}
            y1={y + Math.sin(a) * (r + 2.5)}
            x2={x + Math.cos(a) * (r + 5)}
            y2={y + Math.sin(a) * (r + 5)}
          />
        ))}
      </g>
      <circle className="wx-sun__core" cx={x} cy={y} r={r} />
    </g>
  );
}

/** A flat-bottomed cloud, its bottom edge at `y`, centred on `x`. */
function CloudShape({
  x,
  y,
  scale = 1,
  back = false,
}: {
  x: number;
  y: number;
  scale?: number;
  back?: boolean;
}) {
  return (
    <g
      className={cx("wx-cloud", back && "wx-cloud--back")}
      transform={`translate(${x} ${y}) scale(${scale})`}
    >
      <g className={cx("wx-drift", back && "wx-drift--back")}>
        <circle cx={-6} cy={-4.5} r={4.5} />
        <circle cx={0} cy={-8} r={6.5} />
        <circle cx={6} cy={-4.5} r={4.5} />
        <rect x={-6} y={-4.5} width={12} height={4.5} />
      </g>
    </g>
  );
}

function Drops({ short = false }: { short?: boolean }) {
  const length = short ? 2.5 : 4;
  return (
    <g className="wx-rain">
      {[11, 16, 21].map((x, i) => (
        <line
          key={x}
          className={`wx-drop wx-delay-${i}`}
          x1={x}
          y1={23}
          x2={x - 1}
          y2={23 + length}
        />
      ))}
    </g>
  );
}

function Flakes() {
  return (
    <g className="wx-snow">
      {[
        [11, 25],
        [16, 27.5],
        [21, 25],
      ].map(([x, y], i) => (
        <circle key={x} className={`wx-flake wx-delay-${i}`} cx={x} cy={y} r={1.4} />
      ))}
    </g>
  );
}

function Scene({ kind }: { kind: WeatherKind }) {
  switch (kind) {
    case "clear":
      return <Sun x={16} y={16} r={5.5} />;
    case "partly":
      return (
        <>
          <Sun x={11.5} y={11.5} r={4} />
          <CloudShape x={18.5} y={26} scale={0.95} />
        </>
      );
    case "cloudy":
      return (
        <>
          <CloudShape x={12.5} y={19} scale={0.75} back />
          <CloudShape x={18} y={26} />
        </>
      );
    case "fog":
      return (
        <>
          <CloudShape x={16} y={19} back />
          <g className="wx-fog">
            <line className="wx-drift" x1={7} y1={23.5} x2={25} y2={23.5} />
            <line className="wx-drift wx-drift--back" x1={9} y1={27.5} x2={23} y2={27.5} />
          </g>
        </>
      );
    case "drizzle":
    case "rain":
      return (
        <>
          <CloudShape x={16} y={20.5} />
          <Drops short={kind === "drizzle"} />
        </>
      );
    case "snow":
      return (
        <>
          <CloudShape x={16} y={20.5} />
          <Flakes />
        </>
      );
    case "storm":
      return (
        <>
          <CloudShape x={16} y={20.5} back />
          <polygon
            className="wx-bolt"
            points="17.5,19 12.5,25.5 16,25.5 14,30.5 20.5,23 17,23 19,19"
          />
        </>
      );
  }
}

export function WeatherArt({
  kind,
  live = false,
  className,
}: {
  kind: WeatherKind;
  /** Move all the time (the event popover); otherwise still unless the header is hovered. */
  live?: boolean;
  className?: string;
}) {
  return (
    <svg
      className={cx("weather-art", live && "weather-art--live", className)}
      viewBox="0 0 32 32"
      aria-hidden="true"
      data-kind={kind}
    >
      <Scene kind={kind} />
    </svg>
  );
}
