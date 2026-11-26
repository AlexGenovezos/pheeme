import { CalendarDays, Mail } from "lucide-react";
import { type KeyboardEvent, useLayoutEffect, useRef } from "react";
import { describeShortcut } from "../keyboard/format";
import { useKeybinding } from "../keyboard/useCommands";
import { type AppMode, useCalendarStore } from "./calendarStore";

const MODES: {
  mode: AppMode;
  label: string;
  command: "mode.mail" | "mode.calendar";
  Icon: typeof Mail;
}[] = [
  { mode: "mail", label: "Mail", command: "mode.mail", Icon: Mail },
  {
    mode: "calendar",
    label: "Calendar",
    command: "mode.calendar",
    Icon: CalendarDays,
  },
];

let focusMode: AppMode | null = null;

function ModeButton({ entry, active }: { entry: (typeof MODES)[number]; active: boolean }) {
  const shortcut = useKeybinding(entry.command);
  const { Icon } = entry;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={entry.label}
      data-command={entry.command}
      title={shortcut ? `${entry.label} (${describeShortcut(shortcut)})` : entry.label}
      tabIndex={active ? 0 : -1}
      className="mode-switch__option"
      onClick={() => useCalendarStore.getState().setMode(entry.mode)}
    >
      <Icon aria-hidden="true" />
      <span aria-hidden="true">{entry.label}</span>
    </button>
  );
}

/** The Mail | Calendar switch, the top row of the sidebar's footer. */
export function ModeSwitch() {
  const mode = useCalendarStore((s) => s.mode);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (focusMode === mode)
      ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    focusMode = null;
  }, [mode]);
  const onKeyDown = (e: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const next = mode === "mail" ? "calendar" : "mail";
    // The other mode's switch may not mount until its lazy chunk arrives.
    focusMode = next;
    useCalendarStore.getState().setMode(next);
  };
  return (
    <div
      ref={ref}
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
