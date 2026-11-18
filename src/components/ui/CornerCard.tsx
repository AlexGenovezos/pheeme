import type { ReactNode } from "react";
import { X } from "lucide-react";
import { cx } from "../../lib/utils";
import "./Toast.css";

export interface CornerCardProps {
  title: ReactNode;
  description?: ReactNode;
  /** Before the text, for a card that names a state (offline, slowed, failed). */
  icon?: ReactNode;
  tone?: "neutral" | "danger";
  /** `alert` interrupts a screen reader; most cards are `status`. */
  role?: "status" | "alert";
  /** Stays until answered, so it hides while a dialog is open rather than covering its buttons. */
  waits?: boolean;
  className?: string;
  /** Under the text, inside its column (a progress bar, more lines). */
  children?: ReactNode;
  /** Beside the text: a button or two. */
  action?: ReactNode;
  /** Shows the close button. */
  onDismiss?: () => void;
}

/**
 * One card in the bottom-right corner: every toast, the update offer, the mailbox download and sync
 * trouble (offline, Gmail slowing sync, a failed sync or sign-out) draw through it, so they look and
 * stack alike and none of them pushes the app's content around.
 */
export function CornerCard({
  title,
  description,
  icon,
  tone = "neutral",
  role = "status",
  waits = false,
  className,
  children,
  action,
  onDismiss,
}: CornerCardProps) {
  return (
    <div
      role={role}
      className={cx(
        "ui-toast",
        tone === "danger" && "ui-toast--danger",
        waits && "ui-toast--waits",
        className,
      )}
    >
      {icon && <span className="ui-toast__icon">{icon}</span>}
      <div className="ui-toast__text">
        <span className="ui-toast__title">{title}</span>
        {description && (
          <span className={cx("ui-toast__description", tone === "danger" && "selectable")}>
            {description}
          </span>
        )}
        {children}
      </div>
      {action}
      {onDismiss && (
        <button type="button" className="ui-toast__close" aria-label="Dismiss" onClick={onDismiss}>
          <X />
        </button>
      )}
    </div>
  );
}
