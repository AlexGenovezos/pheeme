import { ChevronLeft, ChevronRight, Minus, Pause, Play, Plus, RotateCcw, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { IconButton } from "../components/ui/IconButton";
import { Kbd } from "../components/ui/Kbd";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { Switch } from "../components/ui/Switch";
import { registry } from "../keyboard/registry";
import { type SpeedReadSession, useSpeedReader } from "./open";
import { useSpeedReaderSettings, WORD_SIZES, type WordSize } from "./settings";
import { MAX_WPM, MIN_WPM, timeLeft, toWords, type Word, wordDuration, WPM_STEP } from "./words";
import "./speedread.css";

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
export const SPEED_PRESETS = [200, 250, 300, 450, 600] as const;
const SIZE_LABELS: Record<WordSize, string> = { medium: "Medium", large: "Large" };

/** Mounted once at the app root; shows the reader while a session is open. */
export function SpeedReaderHost() {
  const session = useSpeedReader((s) => s.session);
  const close = useSpeedReader((s) => s.close);
  return session ? <SpeedReader key={session.id} session={session} onClose={close} /> : null;
}

/** Words per minute: a slider with − and + either side. Shared by the reader and Settings. */
export function SpeedControl() {
  const wpm = useSpeedReaderSettings((s) => s.wpm);
  const update = useSpeedReaderSettings((s) => s.update);
  return (
    <div className="speed-control">
      <IconButton
        size="sm"
        label="Slower"
        icon={<Minus />}
        disabled={wpm <= MIN_WPM}
        onClick={() => update({ wpm: wpm - WPM_STEP })}
      />
      <input
        type="range"
        className="speed-control__slider"
        aria-label="Reading speed"
        aria-valuetext={`${wpm} words per minute`}
        min={MIN_WPM}
        max={MAX_WPM}
        step={WPM_STEP}
        value={wpm}
        onChange={(e) => update({ wpm: Number(e.target.value) })}
      />
      <IconButton
        size="sm"
        label="Faster"
        icon={<Plus />}
        disabled={wpm >= MAX_WPM}
        onClick={() => update({ wpm: wpm + WPM_STEP })}
      />
      <span className="speed-control__value">
        {wpm} <span className="speed-control__unit">wpm</span>
      </span>
    </div>
  );
}

export function PausesControl() {
  const pauses = useSpeedReaderSettings((s) => s.pauses);
  const update = useSpeedReaderSettings((s) => s.update);
  return (
    <Switch
      label="Pause at punctuation"
      checked={pauses}
      onChange={(next) => update({ pauses: next })}
    />
  );
}

export function WordSizeControl() {
  const size = useSpeedReaderSettings((s) => s.size);
  const update = useSpeedReaderSettings((s) => s.update);
  return (
    <SegmentedControl
      label="Word size"
      value={size}
      options={WORD_SIZES.map((value) => ({ value, label: SIZE_LABELS[value] }))}
      onChange={(value) => update({ size: value })}
    />
  );
}

export function OfferControl() {
  const offer = useSpeedReaderSettings((s) => s.offer);
  const update = useSpeedReaderSettings((s) => s.update);
  return (
    <Switch
      label="Offer speed reading"
      checked={offer}
      onChange={(next) => update({ offer: next })}
    />
  );
}

function formatLeft(ms: number): string {
  if (ms < 1000) return "done";
  if (ms < 60_000) return `${Math.ceil(ms / 1000)} s left`;
  return `${Math.ceil(ms / 60_000)} min left`;
}

/** The word, split around its focus letter so that letter sits on the centre line. */
function FlashWord({ word }: { word: Word | undefined }) {
  if (!word) return <div className="speed-reader__word" />;
  const { chars, focus } = word;
  return (
    <div className="speed-reader__word">
      <span className="speed-reader__before">{chars.slice(0, focus).join("")}</span>
      <span className="speed-reader__focus">{chars[focus] ?? ""}</span>
      <span className="speed-reader__after">{chars.slice(focus + 1).join("")}</span>
    </div>
  );
}

/** Keys the focused control needs for itself (arrows on a slider or radio group). */
const ownsArrows = (target: EventTarget) => {
  const el = target as HTMLElement;
  return el.matches?.('input[type="range"], [role="radio"]') ?? false;
};

export function SpeedReader({ session, onClose }: { session: SpeedReadSession; onClose(): void }) {
  const words = useMemo(() => toWords(session.paragraphs), [session.paragraphs]);
  const { wpm, pauses, size, update } = useSpeedReaderSettings();
  const [index, setIndex] = useState(0);
  const [play, setPlay] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const last = words.length - 1;
  // Reading stops by itself on the last word, which stays up.
  const finished = index >= last;
  const playing = play && !finished;
  const [returnFocus] = useState(() => document.activeElement as HTMLElement | null);

  // While the reader is open, keys belong to it.
  useEffect(() => registry.suspend(), []);
  useEffect(() => {
    ref.current?.focus();
    return () => {
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [returnFocus]);

  // One word at a time.
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => setIndex((i) => i + 1), wordDuration(words[index], wpm, pauses));
    return () => clearTimeout(timer);
  }, [playing, index, words, wpm, pauses]);

  const toggle = () => {
    if (finished) setIndex(0);
    setPlay(finished || !playing);
  };
  const step = (by: number) => {
    setPlay(false);
    setIndex((i) => Math.min(last, Math.max(0, i + by)));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const arrows = !ownsArrows(e.target);
    let handled = true;
    if (e.key === "Escape") onClose();
    else if (e.key === " ") toggle();
    else if (arrows && e.key === "ArrowLeft") step(-1);
    else if (arrows && e.key === "ArrowRight") step(1);
    else if (arrows && e.key === "ArrowUp") update({ wpm: wpm + WPM_STEP });
    else if (arrows && e.key === "ArrowDown") update({ wpm: wpm - WPM_STEP });
    else if (e.key === "Tab") {
      handled = false;
      const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (!items.length) return;
      const first = items[0];
      const end = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === ref.current)) {
        e.preventDefault();
        end.focus();
      } else if (!e.shiftKey && active === end) {
        e.preventDefault();
        first.focus();
      }
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const left = timeLeft(words, index, wpm, pauses);
  const playLabel = finished ? "Read again" : playing ? "Pause" : "Play";

  return (
    <div
      className="speed-reader-scrim"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        className="speed-reader"
        role="dialog"
        aria-modal="true"
        aria-label={`Speed read: ${session.title}`}
        tabIndex={-1}
        data-owns-keys=""
        onKeyDown={onKeyDown}
      >
        <header className="speed-reader__header">
          <div className="speed-reader__heading">
            <h2 className="speed-reader__title">{session.title}</h2>
            <p className="speed-reader__meta">
              {Math.min(index + 1, words.length)} / {words.length} words · {formatLeft(left)}
            </p>
          </div>
          <IconButton label="Close speed reader" icon={<X />} onClick={onClose} />
        </header>

        <div className="speed-reader__stage" data-size={size} aria-hidden="true">
          <span className="speed-reader__guide speed-reader__guide--top" />
          <FlashWord word={words[index]} />
          <span className="speed-reader__guide speed-reader__guide--bottom" />
          {!playing && index === 0 && (
            <span className="speed-reader__hint">Press Space to start</span>
          )}
        </div>

        <input
          type="range"
          className="speed-reader__progress"
          aria-label="Position"
          aria-valuetext={`Word ${index + 1} of ${words.length}`}
          min={0}
          max={Math.max(0, last)}
          value={index}
          style={{ "--progress": `${last > 0 ? (index / last) * 100 : 100}%` } as object}
          onChange={(e) => {
            setPlay(false);
            setIndex(Number(e.target.value));
          }}
        />

        <div className="speed-reader__transport">
          <IconButton
            label="Previous word"
            icon={<ChevronLeft />}
            disabled={index === 0}
            onClick={() => step(-1)}
          />
          <button
            type="button"
            className="speed-reader__play"
            aria-label={playLabel}
            title={`${playLabel} (Space)`}
            onClick={toggle}
          >
            {finished ? <RotateCcw /> : playing ? <Pause /> : <Play />}
          </button>
          <IconButton
            label="Next word"
            icon={<ChevronRight />}
            disabled={index >= last}
            onClick={() => step(1)}
          />
        </div>

        <div className="speed-reader__options">
          <div className="speed-reader__option speed-reader__option--speed">
            <span className="speed-reader__option-label">Speed</span>
            <SpeedControl />
            <div className="speed-reader__presets" role="group" aria-label="Speed presets">
              {SPEED_PRESETS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className="speed-reader__preset"
                  aria-pressed={wpm === n}
                  onClick={() => update({ wpm: n })}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <label className="speed-reader__option">
            <span className="speed-reader__option-label">Pause at punctuation</span>
            <PausesControl />
          </label>
          <div className="speed-reader__option">
            <span className="speed-reader__option-label">Word size</span>
            <WordSizeControl />
          </div>
        </div>

        <p className="speed-reader__keys">
          <span>
            <Kbd shortcut="space" /> Play/Pause
          </span>
          <span>
            <Kbd shortcut="left" />
            <Kbd shortcut="right" /> Word
          </span>
          <span>
            <Kbd shortcut="up" />
            <Kbd shortcut="down" /> Speed
          </span>
          <span>
            <Kbd shortcut="escape" /> Close
          </span>
        </p>
      </div>
    </div>
  );
}
