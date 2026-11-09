import { useEffect, useState, type KeyboardEvent, type PointerEvent } from "react";
import { themeColorToHex, toCanonicalThemeColor } from "../../styles/themes/color";

/** Hue 0–360, saturation and value 0–1. */
export interface Hsv {
  h: number;
  s: number;
  v: number;
}

export function hexToHsv(hex: string): Hsv {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  const [r, g, b] = [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return { h: (h * 60 + 360) % 360, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return `#${[f(5), f(3), f(1)]
    .map((c) =>
      Math.round(c * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

const rgbText = (hex: string) => {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return [n >> 16, (n >> 8) & 255, n & 255].join(", ");
};

function rgbToHex(text: string): string | null {
  const parts = text
    .replace(/^rgb\(\s*|\s*\)$/gi, "")
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length !== 3 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255))
    return null;
  return `#${parts.map((p) => p.toString(16).padStart(2, "0")).join("")}`;
}

/** `#rrggbb` for a stored color, keeping a translucent color's alpha aside. */
export function splitColor(value: string): { hex: string; alpha: string } {
  const full = toCanonicalThemeColor(value) ? themeColorToHex(value) : "#000000";
  const alpha = full.length === 9 ? full.slice(7) : "";
  return { hex: full.slice(0, 7), alpha: alpha === "ff" ? "" : alpha };
}

/**
 * Commits run at most once per animation frame (one may rebuild the whole
 * palette), and the last one is flushed on release and on unmount, so no drag
 * position is lost. T3 Code's createFrameCommitter.
 */
function createFrameCommitter() {
  let pending: { hex: string; commit: (hex: string) => void } | null = null;
  let frame: number | null = null;
  const flush = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    const next = pending;
    pending = null;
    next?.commit(next.hex);
  };
  return {
    schedule(hex: string, commit: (hex: string) => void) {
      pending = { hex, commit };
      frame ??= requestAnimationFrame(flush);
    },
    flush,
  };
}

/** A pointer drag over `el`, reported as 0–1 fractions of its box. */
function dragHandlers(onMove: (x: number, y: number) => void, onEnd: () => void) {
  const report = (e: PointerEvent<HTMLElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    onMove(clamp((e.clientX - box.left) / box.width), clamp((e.clientY - box.top) / box.height));
  };
  return {
    onPointerDown(e: PointerEvent<HTMLElement>) {
      e.currentTarget.setPointerCapture(e.pointerId);
      report(e);
    },
    onPointerMove(e: PointerEvent<HTMLElement>) {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) report(e);
    },
    onPointerUp: onEnd,
    onPointerCancel: onEnd,
  };
}

/** The color picker under a color row: saturation/value plane, hue slider, HEX and RGB fields. */
export function ColorPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
}) {
  const { hex, alpha } = splitColor(value);
  const [hsv, setHsv] = useState(() => hexToHsv(hex));
  const [hexDraft, setHexDraft] = useState(hex);
  const [rgbDraft, setRgbDraft] = useState(() => rgbText(hex));
  const [typing, setTyping] = useState(false);
  const [synced, setSynced] = useState(hex);
  const current = hsvToHex(hsv);
  const [committer] = useState(createFrameCommitter);
  useEffect(() => committer.flush, [committer]);

  // An outside change (simple mode rebuilt the palette): follow it, but keep hue
  // and saturation when it is our own echo, since grays lose them in hex.
  if (synced !== hex) {
    setSynced(hex);
    if (!typing) {
      setHexDraft(hex);
      setRgbDraft(rgbText(hex));
    }
    if (current !== hex) setHsv(hexToHsv(hex));
  }

  const setFromHsv = (next: Hsv) => {
    setHsv(next);
    const nextHex = hsvToHex(next);
    setHexDraft(nextHex);
    setRgbDraft(rgbText(nextHex));
    committer.schedule(nextHex, (next) => onChange(next + alpha));
  };

  /** Arrow keys: on the plane, left/right is saturation and up/down brightness; Shift takes bigger steps. */
  const nudge = (e: KeyboardEvent, slider: "plane" | "hue") => {
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    if (slider === "hue")
      return setFromHsv({ ...hsv, h: (hsv.h + step * (e.shiftKey ? 10 : 1) + 360) % 360 });
    const key = e.key === "ArrowUp" || e.key === "ArrowDown" ? "v" : "s";
    const amount = (e.shiftKey ? 0.1 : 0.01) * step;
    setFromHsv({ ...hsv, [key]: Math.min(1, Math.max(0, hsv[key] + amount)) });
  };

  const blur = () => {
    setTyping(false);
    setHexDraft(current);
    setRgbDraft(rgbText(current));
  };

  return (
    <div className="theme-picker">
      <div
        className="theme-picker__plane"
        role="slider"
        tabIndex={0}
        aria-label={`${label} saturation and brightness`}
        aria-valuetext={`saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
        style={{ backgroundColor: hsvToHex({ h: hsv.h, s: 1, v: 1 }) }}
        onKeyDown={(e) => nudge(e, "plane")}
        {...dragHandlers((x, y) => setFromHsv({ ...hsv, s: x, v: 1 - y }), committer.flush)}
      >
        <span
          className="theme-picker__thumb"
          style={{
            left: `${hsv.s * 100}%`,
            top: `${(1 - hsv.v) * 100}%`,
            backgroundColor: current,
          }}
        />
      </div>
      <div
        className="theme-picker__hue"
        role="slider"
        tabIndex={0}
        aria-label={`${label} hue`}
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        onKeyDown={(e) => nudge(e, "hue")}
        {...dragHandlers((x) => setFromHsv({ ...hsv, h: x * 359.9 }), committer.flush)}
      >
        <span
          className="theme-picker__thumb theme-picker__thumb--hue"
          style={{
            left: `${(hsv.h / 360) * 100}%`,
            backgroundColor: hsvToHex({ h: hsv.h, s: 1, v: 1 }),
          }}
        />
      </div>
      <div className="theme-picker__fields">
        <label className="theme-picker__field">
          <span>HEX</span>
          <input
            aria-label={`${label} hex`}
            spellCheck={false}
            value={hexDraft}
            onFocus={() => setTyping(true)}
            onBlur={blur}
            onChange={(e) => {
              const next = e.currentTarget.value;
              setHexDraft(next);
              if (!/^#[0-9a-f]{6}$/i.test(next)) return;
              setHsv(hexToHsv(next));
              setRgbDraft(rgbText(next));
              onChange(next.toLowerCase() + alpha);
            }}
          />
        </label>
        <label className="theme-picker__field">
          <span>RGB</span>
          <input
            aria-label={`${label} RGB`}
            spellCheck={false}
            value={rgbDraft}
            onFocus={() => setTyping(true)}
            onBlur={blur}
            onChange={(e) => {
              const next = e.currentTarget.value;
              setRgbDraft(next);
              const parsed = rgbToHex(next);
              if (!parsed) return;
              setHsv(hexToHsv(parsed));
              setHexDraft(parsed);
              onChange(parsed + alpha);
            }}
          />
        </label>
      </div>
    </div>
  );
}
