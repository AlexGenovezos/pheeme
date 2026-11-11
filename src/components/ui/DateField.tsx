// A date shown as Google Calendar shows it ("Fri, Nov 13, 2026") that opens a month grid. Its
// value is a `YYYY-MM-DD` string ("" for none, with a placeholder). Focus stays on the field: arrows
// move a day or a week, PageUp/PageDown a month (with Shift a year), Home/End to the week's ends,
// Enter or Space picks, Escape closes only the grid.
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  forwardRef,
  type KeyboardEvent,
  useCallback,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { cx } from "../../lib/utils";
import { IconButton } from "./IconButton";
import { focusOnPress, PickerPopover } from "./Picker";

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
const utcOf = (date: string) =>
  Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
const fromUtc = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
export const isDateValue = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
const addDays = (date: string, n: number) => fromUtc(utcOf(date) + n * DAY_MS);
const weekdayOf = (date: string) => new Date(utcOf(date)).getUTCDay();
/** `date` moved by `n` months, kept within the month (Jan 31 + 1 month is Feb 28). */
function addMonths(date: string, n: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)) - 1 + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return fromUtc(Date.UTC(y, m, Math.min(Number(date.slice(8, 10)), last)));
}
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const format = (date: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" }).format(new Date(utcOf(date)));

/** "Fri, Nov 13, 2026". */
export const formatDateValue = (date: string) =>
  format(date, { weekday: "short", month: "short", day: "numeric", year: "numeric" });

const clamp = (date: string, min?: string, max?: string) =>
  min && date < min ? min : max && date > max ? max : date;

export interface DateFieldProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "value" | "onChange" | "children" | "type" | "min" | "max"
> {
  /** `YYYY-MM-DD`, or "" for no date. */
  value: string;
  onChange(date: string): void;
  min?: string;
  max?: string;
  /** The grid's first weekday: 0 Sunday, 1 Monday, 6 Saturday. */
  weekStart?: number;
  /** Shown when there's no date. */
  placeholder?: string;
  /** Opens with the grid showing (a "Go to date" dialog). */
  defaultOpen?: boolean;
}

export const DateField = forwardRef<HTMLButtonElement, DateFieldProps>(function DateField(
  {
    value,
    onChange,
    min,
    max,
    weekStart = 0,
    placeholder = "",
    defaultOpen = false,
    className,
    disabled,
    onKeyDown: onKeyDownProp,
    ...rest
  },
  forwarded,
) {
  const id = useId();
  const gridId = `${id}-grid`;
  const titleId = `${id}-title`;
  const dayId = (date: string) => `${id}-d${date}`;
  const ref = useRef<HTMLButtonElement>(null);
  useImperativeHandle(forwarded, () => ref.current!, []);
  const has = isDateValue(value);
  const [open, setOpen] = useState(defaultOpen);
  const [cursor, setCursor] = useState(() => clamp(has ? value : today(), min, max));
  const spaceHandled = useRef(false);

  const show = () => {
    setCursor(clamp(has ? value : today(), min, max));
    setOpen(true);
  };
  const close = useCallback(() => setOpen(false), []);
  const allowed = (date: string) => !(min && date < min) && !(max && date > max);
  const pick = (date: string) => {
    if (!allowed(date)) return;
    setOpen(false);
    if (date !== value) onChange(date);
  };
  const move = (date: string) => setCursor(clamp(date, min, max));

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    onKeyDownProp?.(e);
    if (e.defaultPrevented || disabled) return;
    if (!open) {
      if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) return;
      if (e.key === " ") spaceHandled.current = true;
      show();
    } else {
      switch (e.key) {
        case "ArrowLeft":
          move(addDays(cursor, -1));
          break;
        case "ArrowRight":
          move(addDays(cursor, 1));
          break;
        case "ArrowUp":
          move(addDays(cursor, -7));
          break;
        case "ArrowDown":
          move(addDays(cursor, 7));
          break;
        case "PageUp":
          move(addMonths(cursor, e.shiftKey ? -12 : -1));
          break;
        case "PageDown":
          move(addMonths(cursor, e.shiftKey ? 12 : 1));
          break;
        case "Home":
          move(addDays(cursor, -((weekdayOf(cursor) - weekStart + 7) % 7)));
          break;
        case "End":
          move(addDays(cursor, 6 - ((weekdayOf(cursor) - weekStart + 7) % 7)));
          break;
        case " ":
          spaceHandled.current = true;
          pick(cursor);
          break;
        case "Enter":
          pick(cursor);
          break;
        case "Escape":
          close();
          break;
        case "Tab":
          close();
          return;
        default:
          return;
      }
    }
    e.preventDefault();
    e.stopPropagation();
  };

  // Six weeks always, so the grid never changes height between months.
  const monthStart = `${cursor.slice(0, 7)}-01`;
  const first = addDays(monthStart, -((weekdayOf(monthStart) - weekStart + 7) % 7));
  const days = Array.from({ length: 42 }, (_, i) => addDays(first, i));
  const now = today();

  return (
    <>
      <button
        {...rest}
        ref={ref}
        type="button"
        role="combobox"
        aria-haspopup="grid"
        aria-expanded={open}
        aria-controls={open ? gridId : undefined}
        aria-activedescendant={open ? dayId(cursor) : undefined}
        disabled={disabled}
        className={cx("ui-field ui-date-field", className)}
        onMouseDown={(e) => {
          rest.onMouseDown?.(e);
          focusOnPress(e);
        }}
        onClick={() => (open ? close() : show())}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => {
          if (e.key === " " && spaceHandled.current) {
            spaceHandled.current = false;
            e.preventDefault();
          }
        }}
        onBlur={close}
      >
        <span className={cx("ui-field__value", !has && "ui-field__value--placeholder")}>
          {has ? formatDateValue(value) : placeholder}
        </span>
        <span className="ui-field__icon" aria-hidden="true">
          <CalendarDays />
        </span>
      </button>
      {open && (
        <PickerPopover anchor={ref} onClose={close}>
          <div className="ui-calendar">
            <div className="ui-calendar__head">
              <span id={titleId} className="ui-calendar__title" aria-live="polite">
                {format(cursor, { month: "long", year: "numeric" })}
              </span>
              <IconButton
                size="sm"
                tabIndex={-1}
                label="Previous month"
                icon={<ChevronLeft />}
                onClick={() => move(addMonths(cursor, -1))}
              />
              <IconButton
                size="sm"
                tabIndex={-1}
                label="Next month"
                icon={<ChevronRight />}
                onClick={() => move(addMonths(cursor, 1))}
              />
            </div>
            <div id={gridId} role="grid" aria-labelledby={titleId} className="ui-calendar__grid">
              <div role="row" className="ui-calendar__row">
                {days.slice(0, 7).map((d) => (
                  <span
                    key={d}
                    role="columnheader"
                    aria-label={format(d, { weekday: "long" })}
                    className="ui-calendar__weekday"
                  >
                    {format(d, { weekday: "narrow" })}
                  </span>
                ))}
              </div>
              {[0, 1, 2, 3, 4, 5].map((w) => (
                <div key={w} role="row" className="ui-calendar__row">
                  {days.slice(w * 7, w * 7 + 7).map((d) => (
                    <div
                      key={d}
                      id={dayId(d)}
                      role="gridcell"
                      aria-label={format(d, {
                        weekday: "long",
                        month: "long",
                        day: "numeric",
                        year: "numeric",
                      })}
                      aria-selected={d === value}
                      aria-disabled={!allowed(d) || undefined}
                      aria-current={d === now ? "date" : undefined}
                      data-active={d === cursor || undefined}
                      className={cx(
                        "ui-calendar__day",
                        d.slice(0, 7) !== cursor.slice(0, 7) && "ui-calendar__day--outside",
                        d === now && "ui-calendar__day--today",
                      )}
                      onClick={() => pick(d)}
                    >
                      {Number(d.slice(8))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </PickerPopover>
      )}
    </>
  );
});
