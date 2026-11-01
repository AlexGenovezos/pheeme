import { Check } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cx } from "../../lib/utils";
import { Kbd } from "./Kbd";
import "./Menu.css";

export type MenuItem =
  | {
      type?: "item";
      id: string;
      label: string;
      shortcut?: string;
      disabled?: boolean;
      /** Renders a check mark (radio/check items). */
      checked?: boolean;
      danger?: boolean;
      onSelect(): void;
    }
  | { type: "separator" };

export interface MenuProps {
  items: MenuItem[];
  /** Viewport coordinates of the top-left corner (clamped to stay on screen). */
  x: number;
  y: number;
  onClose(): void;
  "aria-label"?: string;
}

const isActionable = (item: MenuItem) => item.type !== "separator" && !item.disabled;

/**
 * A DOM menu: the browser-preview stand-in for native context menus, and the
 * base for any in-app dropdown. Arrow keys move, Enter/Space choose, Esc and
 * outside clicks close, focus returns to where it was.
 */
export function Menu({ items, x, y, onClose, ...aria }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(() => items.findIndex(isActionable));
  const [pos, setPos] = useState({ x, y });

  // Keep the menu inside the viewport once its size is known.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const nx = Math.max(0, Math.min(x, window.innerWidth - width));
    const ny = Math.max(0, Math.min(y, window.innerHeight - height));
    if (nx !== x || ny !== y) setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onBlur = () => onClose();
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onBlur);
      previous?.focus?.();
    };
  }, [onClose]);

  const choose = (index: number) => {
    const item = items[index];
    if (!item || !isActionable(item) || item.type === "separator") return;
    onClose();
    item.onSelect();
  };

  const move = (delta: 1 | -1) => {
    if (!items.some(isActionable)) return;
    let i = active;
    do i = (i + delta + items.length) % items.length;
    while (!isActionable(items[i]));
    setActive(i);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        move(1);
        break;
      case "ArrowUp":
        move(-1);
        break;
      case "Home":
        setActive(items.findIndex(isActionable));
        break;
      case "End":
        setActive(items.length - 1 - [...items].reverse().findIndex(isActionable));
        break;
      case "Enter":
      case " ":
        choose(active);
        break;
      case "Escape":
      case "Tab":
        onClose();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      className="ui-menu"
      style={{ left: pos.x, top: pos.y }}
      aria-activedescendant={active >= 0 ? `ui-menu-item-${active}` : undefined}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      {...aria}
    >
      {items.map((item, i) =>
        item.type === "separator" ? (
          <div key={`sep-${i}`} role="separator" className="ui-menu__separator" />
        ) : (
          <div
            key={item.id}
            id={`ui-menu-item-${i}`}
            role={item.checked != null ? "menuitemcheckbox" : "menuitem"}
            aria-checked={item.checked}
            aria-disabled={item.disabled || undefined}
            data-active={i === active || undefined}
            className={cx("ui-menu__item", item.danger && "ui-menu__item--danger")}
            onPointerMove={() => !item.disabled && setActive(i)}
            onClick={() => choose(i)}
          >
            <span className="ui-menu__check">{item.checked && <Check />}</span>
            <span className="ui-menu__label">{item.label}</span>
            {item.shortcut && <Kbd shortcut={item.shortcut} className="ui-menu__shortcut" />}
          </div>
        ),
      )}
    </div>
  );
}
