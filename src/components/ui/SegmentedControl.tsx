import { type KeyboardEvent, useRef } from "react";
import { cx } from "../../lib/utils";
import "./SegmentedControl.css";

export interface Segment<T extends string> {
  value: T;
  label: string;
  /** A muted number after the label, e.g. how many items the choice shows. */
  count?: number;
}

/**
 * A small radio group drawn as joined buttons. Arrow keys move the choice, as in any radio group;
 * only the chosen segment is in the tab order.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: readonly Segment<T>[];
  onChange(value: T): void;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    const next = (i + step + options.length) % options.length;
    onChange(options[next].value);
    ref.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      className={cx("ui-segmented", className)}
      onKeyDown={onKeyDown}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className="ui-segmented__option"
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count !== undefined && (
            <>
              {" "}
              <span className="ui-segmented__count">{o.count}</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}
