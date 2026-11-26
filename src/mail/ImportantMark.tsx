import type { MouseEventHandler } from "react";
import { describeShortcut } from "../keyboard/format";
import "./mail.css";

/**
 * Gmail's importance marker at the start of a list row: filled when the conversation is important, an outline on
 * hover when it isn't. The slot is the same size either way, so no row ever changes width. A mouse target only
 * (the row is an option, so no button inside it): the keyboard path is the shortcut in its tooltip.
 */
export function ImportantMark(props: {
  important: boolean;
  /** False in Spam and Trash, where Gmail shows no importance: no hover outline, no click. */
  enabled: boolean;
  shortcut: string | undefined;
  onClick: MouseEventHandler<HTMLElement>;
}) {
  const { important, enabled, shortcut, onClick } = props;
  const label = important ? "Mark as not important" : "Mark as important";
  return (
    <span
      className="thread-row__important"
      data-important={important || undefined}
      data-disabled={!enabled || undefined}
      data-command={important ? "conversation.mark-not-important" : "conversation.mark-important"}
      role={important ? "img" : undefined}
      aria-label={important ? "Important" : undefined}
      aria-hidden={important ? undefined : "true"}
      title={enabled ? (shortcut ? `${label} (${describeShortcut(shortcut)})` : label) : undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={enabled ? onClick : undefined}
    >
      <svg viewBox="0 0 16 16" className="thread-row__important-glyph" aria-hidden="true">
        <path d="M2.5 3h7.2L14 8l-4.3 5H2.5L6.8 8z" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
