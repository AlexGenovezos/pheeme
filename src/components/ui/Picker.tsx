// What Select, DateField and TimeField share: a popover pinned under (or over) its field, and the
// list of options inside it. Focus never leaves the field: it drives the popover through
// aria-activedescendant, so a picker inside a Modal or a popover with its own Escape and focus
// handling needs nothing from it. The popover is portaled to <body> so a scrolling dialog can't
// clip it, and marked `data-picker` so outside-click handlers can tell it's part of the field.
import { Check } from "lucide-react";
import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/utils";
import "./Picker.css";

/** Gap between the field and its popover, and from the window's edges. */
const GAP = 4;

/** Whether an event target is inside a picker's popover (for outside-click handlers). */
/**
 * Mousedown on a picker's field: focus it ourselves. WebKit (macOS) doesn't focus a clicked
 * button, so without this the field never gets its keys and the field before it (a task's
 * title, which saves on blur) sees focus go nowhere.
 */
export function focusOnPress(e: MouseEvent<HTMLElement>) {
  if (e.button !== 0 || e.currentTarget.matches(":disabled")) return;
  e.preventDefault();
  e.currentTarget.focus();
}

export const inPicker = (target: EventTarget | null) =>
  target instanceof Element && target.closest("[data-picker]") !== null;

export interface PickerPopoverProps {
  anchor: RefObject<HTMLElement | null>;
  onClose(): void;
  id?: string;
  className?: string;
  /** At least as wide as the field. */
  matchWidth?: boolean;
  children: ReactNode;
}

/** The popover: under the field, or over it when there's more room there. */
export function PickerPopover({
  anchor,
  onClose,
  id,
  className,
  matchWidth = false,
  children,
}: PickerPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });

  const place = useCallback(() => {
    const el = ref.current;
    const at = anchor.current?.getBoundingClientRect();
    if (!el || !at) return;
    const width = Math.max(el.offsetWidth, matchWidth ? at.width : 0);
    // A list is capped by its CSS (--picker-list-max-height); placing it must not lift the cap.
    const cap = el.classList.contains("ui-picker--list")
      ? parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue("--picker-list-max-height"),
        )
      : Infinity;
    const height = Math.min(el.scrollHeight, cap);
    const below = window.innerHeight - at.bottom - 2 * GAP;
    const above = at.top - 2 * GAP;
    const down = below >= height || below >= above;
    const room = Math.max(0, down ? below : above);
    const shown = Math.min(height, room);
    const left = Math.max(GAP, Math.min(at.left, window.innerWidth - width - GAP));
    const top = down ? at.bottom + GAP : at.top - GAP - shown;
    setStyle({
      left,
      top,
      minWidth: matchWidth ? at.width : undefined,
      maxHeight: Math.min(room, cap) < el.scrollHeight ? Math.min(room, cap) : undefined,
    });
  }, [anchor, matchWidth]);

  useLayoutEffect(place, [place]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    // The page or a dialog scrolled: follow the field (the popover's own scrolling doesn't count).
    const onScroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) place();
    };
    const onBlur = () => onClose();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("blur", onBlur);
    };
  }, [anchor, onClose, place]);

  return createPortal(
    <div
      ref={ref}
      id={id}
      className={cx("ui-picker", className)}
      style={style}
      data-picker=""
      // Clicks inside keep focus on the field.
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface ListOption {
  id: string;
  label: string;
  disabled?: boolean;
  selected?: boolean;
  /** A heading shown above the first option of its group. */
  group?: string;
}

/** Scroll `id` into view inside its popover. */
export function revealOption(id: string | undefined, block: ScrollLogicalPosition = "nearest") {
  if (!id) return;
  document.getElementById(id)?.scrollIntoView?.({ block });
}

/** A listbox of options; the active one (keyboard or pointer) is highlighted, the chosen one ticked. */
export function Listbox({
  id,
  label,
  options,
  active,
  onActive,
  onPick,
}: {
  id: string;
  label?: string;
  options: readonly ListOption[];
  active: number;
  onActive(index: number): void;
  onPick(index: number): void;
}) {
  // Options grouped by consecutive `group`, each group headed by its name.
  const groups: { name?: string; items: { option: ListOption; index: number }[] }[] = [];
  options.forEach((option, index) => {
    const last = groups[groups.length - 1];
    if (last && last.name === option.group) last.items.push({ option, index });
    else groups.push({ name: option.group, items: [{ option, index }] });
  });
  const row = ({ option, index }: { option: ListOption; index: number }) => (
    <div
      key={option.id}
      id={option.id}
      role="option"
      aria-selected={option.selected ?? false}
      aria-disabled={option.disabled || undefined}
      data-active={index === active || undefined}
      className="ui-listbox__option"
      onPointerMove={() => !option.disabled && index !== active && onActive(index)}
      onClick={() => !option.disabled && onPick(index)}
    >
      <span className="ui-listbox__check">{option.selected && <Check />}</span>
      <span className="ui-listbox__label">{option.label}</span>
    </div>
  );
  return (
    <div id={id} role="listbox" aria-label={label} className="ui-listbox">
      {groups.map((g, i) =>
        g.name === undefined ? (
          g.items.map(row)
        ) : (
          <div key={`${g.name}-${i}`} role="group" aria-labelledby={`${id}-g${i}`}>
            <div id={`${id}-g${i}`} className="ui-listbox__group" role="presentation">
              {g.name}
            </div>
            {g.items.map(row)}
          </div>
        ),
      )}
    </div>
  );
}

/**
 * The enabled option `delta` enabled options away from `from` (-1 is before the first, `length`
 * after the last), stopping at the ends; `from` itself when there's none.
 */
export function step(options: readonly { disabled?: boolean }[], from: number, delta: number) {
  const dir = delta < 0 ? -1 : 1;
  let left = Math.max(1, Math.abs(delta));
  let found = from;
  for (let i = from + dir; i >= 0 && i < options.length && left > 0; i += dir) {
    if (options[i].disabled) continue;
    found = i;
    left--;
  }
  return found;
}

/** The first (`1`) or last (`-1`) enabled option. */
export const edge = (options: readonly { disabled?: boolean }[], dir: 1 | -1) =>
  step(options, dir === 1 ? -1 : options.length, dir);

/**
 * Type-ahead, as in a native select: letters typed within a moment of each other find the next
 * label starting with them; one letter repeated cycles through labels with that letter.
 */
export function useTypeahead(labels: readonly string[], disabled?: readonly boolean[]) {
  const buffer = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const typing = () => buffer.current !== "";
  const find = (key: string, from: number): number => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => (buffer.current = ""), 600);
    buffer.current += key.toLowerCase();
    const text = buffer.current;
    const repeated = [...text].every((c) => c === text[0]);
    const query = repeated ? text[0] : text;
    const n = labels.length;
    // A longer query keeps the current match if it still fits; a single letter moves on.
    const start = repeated || text.length === 1 ? from + 1 : from;
    for (let k = 0; k < n; k++) {
      const i = (((start + k) % n) + n) % n;
      if (!disabled?.[i] && labels[i].toLowerCase().startsWith(query)) return i;
    }
    return -1;
  };
  return { find, typing };
}

/** A printable key with no modifiers (for type-ahead). */
export const isPrintable = (e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}) => e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
