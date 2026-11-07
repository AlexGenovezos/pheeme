// "Label colour…": Gmail's 64-colour grid for one label, plus Remove colour. Opened from a sidebar label's menu,
// which can't hold the grid itself (native menus have no swatches).
import { Check } from "lucide-react";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Button } from "../components/ui/Button";
import { cx } from "../lib/utils";
import { useLabelStore } from "../store/labelStore";
import { editLabel } from "./edit";
import { LABEL_BACKGROUNDS, labelColor } from "./palette";
import "./labels.css";

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

/**
 * Gmail's 64-colour grid as one radio group (one tab stop, arrow keys between swatches), ticking `value`. Shared by
 * the colour popover and the new-label dialog.
 */
export function ColorGrid({
  value,
  onChoose,
}: {
  /** The ticked background, or null for none. */
  value: string | null;
  onChoose(background: string): void;
}) {
  const checked = value ? LABEL_BACKGROUNDS.indexOf(value.toLowerCase()) : -1;
  const [focused, setFocused] = useState(Math.max(checked, 0));
  const swatches = useRef<Array<HTMLButtonElement | null>>([]);

  const moveTo = (index: number) => {
    const next = Math.max(0, Math.min(LABEL_BACKGROUNDS.length - 1, index));
    setFocused(next);
    swatches.current[next]?.focus();
  };

  const onGridKey = (e: KeyboardEvent) => {
    const row = focused - (focused % COLUMNS);
    switch (e.key) {
      case "ArrowRight":
        moveTo(focused + 1);
        break;
      case "ArrowLeft":
        moveTo(focused - 1);
        break;
      case "ArrowDown":
        moveTo(focused + COLUMNS);
        break;
      case "ArrowUp":
        moveTo(focused - COLUMNS);
        break;
      case "Home":
        moveTo(row);
        break;
      case "End":
        moveTo(row + COLUMNS - 1);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="label-color__grid" role="radiogroup" aria-label="Colour" onKeyDown={onGridKey}>
      {LABEL_BACKGROUNDS.map((background, i) => {
        const on = i === checked;
        return (
          <button
            key={background}
            ref={(el) => {
              swatches.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={background}
            title={background}
            tabIndex={i === focused ? 0 : -1}
            className={cx("label-color__swatch", on && "label-color__swatch--on")}
            style={{ background, color: labelColor(background).text }}
            onFocus={() => setFocused(i)}
            onClick={() => {
              setFocused(i);
              onChoose(background);
            }}
          >
            {on && <Check aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}

/** Focuses the grid's tab stop: the ticked swatch, else the first. */
const focusGrid = (el: HTMLElement | null) =>
  el?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();

export function ColorPopover({ spec, onClose }: { spec: ColorPopoverSpec; onClose(): void }) {
  const { accountId, labelId, at, returnFocus } = spec;
  const label = useLabelStore((s) => s.labels[accountId]?.find((l) => l.id === labelId));
  const current = label?.colorBackground?.toLowerCase() ?? null;
  const [pos, setPos] = useState(at);
  const ref = useRef<HTMLDivElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);

  // Keep the popover inside the viewport once its size is known.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(at.x, window.innerWidth - width));
    const y = Math.max(0, Math.min(at.y, window.innerHeight - height));
    if (x !== at.x || y !== at.y) setPos({ x, y });
  }, [at]);

  useEffect(() => {
    focusGrid(ref.current);
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onBlur = () => onClose();
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onBlur);
      returnFocus?.focus?.();
    };
  }, [onClose, returnFocus]);

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
      className="label-color"
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
