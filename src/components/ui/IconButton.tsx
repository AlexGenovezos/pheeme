import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { describeShortcut } from "../../keyboard/format";
import { cx } from "../../lib/utils";
import "./Button.css";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Accessible name and native tooltip. Required: icon-only buttons need words somewhere. */
  label: string;
  icon: ReactNode;
  /** Shown in the tooltip, e.g. "e" → "Archive (E)". */
  shortcut?: string;
  size?: "sm" | "md";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, shortcut, size = "md", className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={shortcut ? `${label} (${describeShortcut(shortcut)})` : label}
      className={cx("ui-icon-button", size === "sm" && "ui-icon-button--sm", className)}
      {...rest}
    >
      {icon}
    </button>
  );
});
