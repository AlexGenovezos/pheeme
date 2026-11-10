import { CalendarDays, Mail } from "lucide-react";
import type { KeyboardEvent } from "react";
import { describeShortcut } from "../keyboard/format";
import { useKeybinding } from "../keyboard/useCommands";
import { type AppMode, useCalendarStore } from "./calendarStore";

const MODES: {
  mode: AppMode;
  label: string;
  command: string;
  fallback: string;
  Icon: typeof Mail;
}[] = [
  { mode: "mail", label: "Mail", command: "mode.mail", fallback: "mod+1", Icon: Mail },
  {
    mode: "calendar",
    label: "Calendar",
    command: "mode.calendar",
    fallback: "mod+2",
    Icon: CalendarDays,
  },
];

function ModeButton({ entry, active }: { entry: (typeof MODES)[number]; active: boolean }) {
  const shortcut = useKeybinding(entry.command, entry.fallback);
  const { Icon } = entry;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={entry.label}
      title={shortcut ? `${entry.label} (${describeShortcut(shortcut)})` : entry.label}
      tabIndex={active ? 0 : -1}
      className="mode-switch__option"
      onClick={() => useCalendarStore.getState().setMode(entry.mode)}
    >
      <Icon aria-hidden="true" />
    </button>
  );
}

/** The Mail | Calendar switch at the top of the sidebar. */
export function ModeSwitch() {
  const mode = useCalendarStore((s) => s.mode);
  const onKeyDown = (e: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const next = mode === "mail" ? "calendar" : "mail";
    useCalendarStore.getState().setMode(next);
    // The other mode's sidebar has its own switch: keep focus on it there.
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>('.mode-switch [aria-checked="true"]')?.focus(),
    );
  };
  return (
    <div
      role="radiogroup"
      aria-label="Mail or Calendar"
      className="mode-switch"
      onKeyDown={onKeyDown}
    >
      {MODES.map((entry) => (
        <ModeButton key={entry.mode} entry={entry} active={entry.mode === mode} />
      ))}
    </div>
  );
}
