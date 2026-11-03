import { cx } from "../../lib/utils";
import "./Switch.css";

/** An on/off toggle (`role="switch"`). `label` names it for screen readers when no visible label points at it. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onChange(checked: boolean): void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cx("ui-switch", className)}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-switch__thumb" aria-hidden="true" />
    </button>
  );
}
