import type { HTMLAttributes } from "react";
import { cx } from "../../lib/utils";
import "./Badge.css";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: "neutral" | "accent";
  /** Numeric badges cap at 999+. Pass children instead for text. */
  count?: number;
}

export const formatCount = (n: number) => (n > 999 ? "999+" : String(n));

export function Badge({ tone = "neutral", count, className, children, ...rest }: BadgeProps) {
  return (
    <span className={cx("ui-badge", `ui-badge--${tone}`, className)} {...rest}>
      {count != null ? formatCount(count) : children}
    </span>
  );
}
