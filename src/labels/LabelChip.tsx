// A label as a small pill: Gmail's colours when it has them, the badge tokens when it doesn't.
import { X } from "lucide-react";
import type { CSSProperties } from "react";
import { cx } from "../lib/utils";
import type { LabelInfo } from "../lib/tauri";
import { chipColors } from "./palette";
import "./labels.css";

export interface LabelChipProps {
  label: LabelInfo;
  /** Shows a × that calls this. */
  onRemove?: () => void;
}

export function LabelChip({ label, onRemove }: LabelChipProps) {
  const colors = chipColors(label);
  // Gmail's colours are data, so they are inline styles rather than tokens.
  const style: CSSProperties | undefined = colors
    ? { backgroundColor: colors.background, color: colors.color }
    : undefined;
  return (
    <span
      className={cx("label-chip", colors?.border && "label-chip--outlined")}
      style={style}
      title={label.name}
    >
      <span className="label-chip__name">{label.name}</span>
      {onRemove && (
        <button
          type="button"
          className="label-chip__remove"
          aria-label={`Remove label ${label.name}`}
          onClick={onRemove}
        >
          <X aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
