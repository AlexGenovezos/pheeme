// "Label colour…": Gmail's 64-colour grid for one label, plus Remove colour. Opened from a sidebar label's menu,
// which can't hold the grid itself (native menus have no swatches).
import { Check } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Button } from "../components/ui/Button";
import { usePopover } from "../components/ui/usePopover";
import { cx } from "../lib/utils";
import { useLabelStore } from "../store/labelStore";
import { editLabel } from "./edit";
import { LABEL_BACKGROUNDS, labelColor } from "./palette";
import "./labels.css";
import "../components/ui/Surface.css";

export interface ColorPopoverSpec {
  accountId: string;
  labelId: string;
  /** Viewport coordinates of its top-left corner (clamped to stay on screen). */
  at: { x: number; y: number };
  /** Where focus goes when it closes. */
  returnFocus?: HTMLElement | null;
}

/** `seq` changes per open, so a re-opened popover starts fresh. */
const useColorPopoverStore = create<{ spec: (ColorPopoverSpec & { seq: number }) | null }>(() => ({
  spec: null,
}));

let seq = 0;

export function openColorPopover(spec: ColorPopoverSpec): void {
  useColorPopoverStore.setState({ spec: { ...spec, seq: ++seq } });
}

const closeColorPopover = () => useColorPopoverStore.setState({ spec: null });

/** Swatches per row, as in Gmail's grid. */
const COLUMNS = 8;

/** One colour of a `SwatchGrid`. */
export interface Swatch {
  /** What choosing it reports. */
  value: string;
  /** Its name, for screen readers and the tooltip. */
  name: string;
  /** Its fill, and the colour of the tick drawn on it: any CSS colour. */
  background: string;
  foreground: string;
}

/**
 * Gmail's 64-colour grid as one radio group (one tab stop, arrow keys between swatches), ticking `value`. Shared by
 * the colour popover and the new-label dialog.
 */
export function ColorGrid({
  value,
  onChoose,
  wide = false,
}: {
  /** The ticked background, or null for none. */
  value: string | null;
  onChoose(background: string): void;
  /** Stretches the swatches across the container's width instead of fixed squares. */
  wide?: boolean;
}) {
  return (
    <SwatchGrid
      swatches={GMAIL_SWATCHES}
      value={value?.toLowerCase() ?? null}
      onChoose={onChoose}
      wide={wide}
    />
  );
}

const GMAIL_SWATCHES: Swatch[] = LABEL_BACKGROUNDS.map((background) => ({
  value: background,
  name: background,
  background,
  foreground: labelColor(background).text,
}));

/**
 * Colour swatches as one radio group (one tab stop, arrow keys between swatches), `columns` to a row, ticking
 * `value`. Arrow keys stay inside it.
 */
export function SwatchGrid({
  swatches: colors,
  value,
  onChoose,
  columns = COLUMNS,
  wide = false,
}: {
  swatches: Swatch[];
  /** The ticked swatch's value, or null for none. */
  value: string | null;
  onChoose(value: string): void;
  columns?: number;
  /** Stretches the swatches across the container's width instead of fixed squares. */
  wide?: boolean;
}) {
  const checked = value ? colors.findIndex((c) => c.value === value) : -1;
  const [focused, setFocused] = useState(Math.max(checked, 0));
  const swatches = useRef<Array<HTMLButtonElement | null>>([]);

  const moveTo = (index: number) => {
    const next = Math.max(0, Math.min(colors.length - 1, index));
    setFocused(next);
    swatches.current[next]?.focus();
  };

  const onGridKey = (e: KeyboardEvent) => {
    const row = focused - (focused % columns);
    switch (e.key) {
      case "ArrowRight":
        moveTo(focused + 1);
        break;
      case "ArrowLeft":
        moveTo(focused - 1);
        break;
      case "ArrowDown":
        moveTo(focused + columns);
        break;
      case "ArrowUp":
        moveTo(focused - columns);
        break;
      case "Home":
        moveTo(row);
        break;
      case "End":
        moveTo(row + columns - 1);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      className={cx("label-color__grid", wide && "label-color__grid--wide")}
      role="radiogroup"
      aria-label="Colour"
      style={{ "--swatch-columns": columns } as CSSProperties}
      onKeyDown={onGridKey}
    >
      {colors.map(({ value: color, name, background, foreground }, i) => {
        const on = i === checked;
        return (
          <button
            key={color}
            ref={(el) => {
              swatches.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={name}
            title={name}
            tabIndex={i === focused ? 0 : -1}
            className={cx("label-color__swatch", on && "label-color__swatch--on")}
            style={{ background, color: foreground }}
            onFocus={() => setFocused(i)}
            onClick={() => {
              setFocused(i);
              onChoose(color);
            }}
          >
            {on && <Check aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}

/** The grid's tab stop: the ticked swatch, else the first. */
const gridStop = (el: HTMLElement | null) => el?.querySelector<HTMLElement>('[tabindex="0"]');
const focusGrid = (el: HTMLElement | null) => gridStop(el)?.focus();

export function ColorPopover({ spec, onClose }: { spec: ColorPopoverSpec; onClose(): void }) {
  const { accountId, labelId, at, returnFocus } = spec;
  const label = useLabelStore((s) => s.labels[accountId]?.find((l) => l.id === labelId));
  const current = label?.colorBackground?.toLowerCase() ?? null;
  const ref = useRef<HTMLDivElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const { pos } = usePopover({ ref, at, onClose, focusIn: gridStop, returnFocus });

  // The label was deleted (here or in Gmail) while the popover was open.
  useEffect(() => {
    if (!label) onClose();
  }, [label, onClose]);

  const choose = (background: string) => {
    onClose();
    if (background !== current)
      void editLabel(accountId, labelId, { color: labelColor(background) });
  };

  const remove = () => {
    onClose();
    if (current) void editLabel(accountId, labelId, { clearColor: true });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "Tab") {
      // Two stops, the grid and Remove colour; focus stays in the popover until it closes.
      const inGrid = document.activeElement !== removeRef.current;
      if (inGrid && !removeRef.current?.disabled) removeRef.current?.focus();
      else focusGrid(ref.current);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={ref}
      className="label-color popover-surface"
      role="dialog"
      aria-label="Label colour"
      data-owns-keys=""
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      <ColorGrid value={current} onChoose={choose} />
      <Button
        ref={removeRef}
        variant="ghost"
        size="sm"
        className="label-color__remove"
        disabled={!current}
        onClick={remove}
      >
        Remove colour
      </Button>
    </div>
  );
}

/** Renders the open colour popover, if any. Mount once. */
export function ColorPopoverHost() {
  const spec = useColorPopoverStore((s) => s.spec);
  if (!spec) return null;
  return <ColorPopover key={spec.seq} spec={spec} onClose={closeColorPopover} />;
}
