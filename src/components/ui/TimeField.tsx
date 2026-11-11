// A time of day you can type the way Google Calendar takes it ("3p", "3:30pm", "15:30", "330")
// or pick from a list in 15-minute steps. Its value is minutes since midnight. With `durationFrom`
// (an end time) the list starts after that time and says how long the event would be:
// "11:30 AM (30 mins)". Enter or leaving the field keeps what was typed; Escape puts it back.
import {
  type InputHTMLAttributes,
  type KeyboardEvent,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { cx } from "../../lib/utils";
import { Listbox, type ListOption, PickerPopover, revealOption } from "./Picker";

const DAY = 24 * 60;

/** Minutes since midnight from what someone typed, or null when it isn't a time. */
export function parseTimeText(text: string): number | null {
  const t = text.toLowerCase().replace(/\s+/g, "");
  if (t === "noon") return 12 * 60;
  if (t === "midnight") return 0;
  const m = /^(\d{1,2})(?:[:.h]?(\d{2}))?(?:([ap])\.?m?\.?)?$/.exec(t);
  if (!m) return null;
  let hours = Number(m[1]);
  const minutes = m[2] ? Number(m[2]) : 0;
  if (minutes > 59) return null;
  if (m[3]) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (m[3] === "p" ? 12 : 0);
  } else if (hours > 23) return null;
  return hours * 60 + minutes;
}

let clock: Intl.DateTimeFormat | undefined;
/** A time of day in the user's locale: "3:30 PM" or "15:30". */
export function formatTimeOfDay(minutes: number): string {
  clock ??= new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
  const m = ((minutes % DAY) + DAY) % DAY;
  return clock.format(new Date(Date.UTC(2000, 0, 1, Math.floor(m / 60), m % 60)));
}

/** "30 mins", "1 hr", "1.5 hrs", as Google labels the end times. */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} mins`;
  const hours = Math.round((minutes / 60) * 100) / 100;
  return `${hours} ${hours === 1 ? "hr" : "hrs"}`;
}

export interface TimeFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "type" | "step"
> {
  /** Minutes since midnight. */
  value: number;
  onChange(minutes: number): void;
  /** An end time: list the times after this one, each with the length it would make. */
  durationFrom?: number;
  /** Minutes between listed times. */
  step?: number;
}

export function TimeField({
  value,
  onChange,
  durationFrom,
  step = 15,
  className,
  disabled,
  onKeyDown: onKeyDownProp,
  onBlur: onBlurProp,
  onFocus: onFocusProp,
  ...rest
}: TimeFieldProps) {
  const id = useId();
  const listId = `${id}-list`;
  const optionId = (i: number) => `${id}-o${i}`;
  const wrap = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  /** What's being typed; null shows the value. */
  const [text, setText] = useState<string | null>(null);
  /** Arrows picked an option since the list opened, so Enter takes it rather than the text. */
  const navigated = useRef(false);
  const keepSelection = useRef(false);

  const times = useMemo(() => {
    const count = Math.floor(DAY / step);
    return durationFrom == null
      ? Array.from({ length: count }, (_, i) => ({ minutes: i * step, label: "" }))
      : Array.from({ length: count }, (_, i) => {
          const length = (i + 1) * step;
          return { minutes: (durationFrom + length) % DAY, label: formatDuration(length) };
        });
  }, [durationFrom, step]);
  const list: ListOption[] = times.map((t, i) => ({
    id: optionId(i),
    label: t.label ? `${formatTimeOfDay(t.minutes)} (${t.label})` : formatTimeOfDay(t.minutes),
    selected: t.minutes === value,
  }));

  /** The listed time nearest `minutes` (the one at or after it, in list order). */
  const nearest = (minutes: number) => {
    const exact = times.findIndex((t) => t.minutes === minutes);
    if (exact >= 0) return exact;
    const base = durationFrom ?? 0;
    const offset = (((minutes - base) % DAY) + DAY) % DAY;
    const i = durationFrom == null ? Math.ceil(offset / step) : Math.ceil(offset / step) - 1;
    return Math.max(0, Math.min(times.length - 1, i));
  };

  const move = (i: number, block: ScrollLogicalPosition = "nearest") => {
    setActive(i);
    revealOption(optionId(i), block);
  };
  const show = (at: number) => {
    navigated.current = false;
    setOpen(true);
    setActive(at);
    requestAnimationFrame(() => revealOption(optionId(at), "center"));
  };
  const close = useCallback(() => setOpen(false), []);
  const set = (minutes: number) => {
    setText(null);
    if (minutes !== value) onChange(minutes);
  };
  const commit = () => {
    if (text == null) return;
    const parsed = parseTimeText(text);
    if (parsed == null) setText(null);
    else set(parsed);
  };
  const pick = (i: number) => {
    close();
    set(times[i].minutes);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    onKeyDownProp?.(e);
    if (e.defaultPrevented || disabled) return;
    const by = (n: number) => {
      if (!open) return show(nearest(value));
      navigated.current = true;
      move(Math.max(0, Math.min(times.length - 1, active + n)));
    };
    switch (e.key) {
      case "ArrowDown":
        by(1);
        break;
      case "ArrowUp":
        by(-1);
        break;
      case "PageDown":
        by(4);
        break;
      case "PageUp":
        by(-4);
        break;
      case "Enter":
        if (open && navigated.current) pick(active);
        else if (text != null) {
          commit();
          close();
        } else if (open) close();
        // Nothing changed: Enter belongs to the form (quick create saves).
        else return;
        break;
      case "Escape":
        if (!open && text == null) return;
        close();
        setText(null);
        break;
      case "Tab":
        close();
        return;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <span
      ref={wrap}
      className={cx("ui-field ui-time-field", className)}
      // A press on the padding still edits the time.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault();
          input.current?.focus();
        }
        if (!open && !disabled) show(nearest(value));
      }}
    >
      <input
        {...rest}
        ref={input}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        className="ui-time-field__input"
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        value={text ?? formatTimeOfDay(value)}
        onFocus={(e) => {
          onFocusProp?.(e);
          e.currentTarget.select();
          keepSelection.current = true;
        }}
        // The click that focused the field mustn't drop the selection, so typing replaces the time.
        onMouseUp={(e) => {
          if (keepSelection.current) e.preventDefault();
          keepSelection.current = false;
        }}
        onChange={(e) => {
          const next = e.currentTarget.value;
          setText(next);
          const parsed = parseTimeText(next);
          if (!open) show(parsed == null ? nearest(value) : nearest(parsed));
          else if (parsed != null) move(nearest(parsed), "center");
          navigated.current = false;
        }}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          onBlurProp?.(e);
          keepSelection.current = false;
          commit();
          close();
        }}
      />
      {open && (
        <PickerPopover anchor={wrap} onClose={close} className="ui-picker--list" matchWidth>
          <Listbox
            id={listId}
            label={rest["aria-label"]}
            options={list}
            active={active}
            onActive={(i) => {
              navigated.current = true;
              setActive(i);
            }}
            onPick={pick}
          />
        </PickerPopover>
      )}
    </span>
  );
}
