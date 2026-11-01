import type { CSSProperties } from "react";
import { cx } from "../../lib/utils";
import "./Skeleton.css";

export interface SkeletonProps {
  shape?: "text" | "circle" | "block";
  /** Any CSS length; content-specific, so passed by the caller. */
  width?: CSSProperties["width"];
  className?: string;
}

/** Placeholder for content that isn't cached yet. Only for an account's very first sync (design §5). */
export function Skeleton({ shape = "text", width, className }: SkeletonProps) {
  return (
    <span
      className={cx("ui-skeleton", `ui-skeleton--${shape}`, className)}
      style={width != null ? { width } : undefined}
      aria-hidden="true"
    />
  );
}
