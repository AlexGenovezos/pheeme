// A calendar's colour: the palette button on its sidebar row (or a right-click on the row) opens
// Google Calendar's 24 calendar colours. The one picked shows at once and is saved to the
// account's Google calendar list, so the website and phones show it too. The first time, Google
// asks the account to allow it (`{ kind: "calendarColors" }`), and the colour is saved after that.
import { Palette } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { toastError } from "../components/ui/Toast";
import { usePopover } from "../components/ui/usePopover";
import { type Swatch, SwatchGrid } from "../labels/ColorPopover";
import { type CalendarInfo, toCommandError } from "../lib/tauri";
import { useSignIn } from "../onboarding/useSignIn";
import { below } from "../shell/sidebar/keys";
import { useCalendarStore } from "./calendarStore";
import { CALENDAR_COLORS, calendarColor, textOn } from "./colors";
import "../labels/labels.css";
import "../components/ui/Surface.css";

const SWATCHES: Swatch[] = CALENDAR_COLORS.map(({ color, name }) => ({
  value: color,
  name,
  background: color,
  foreground: textOn(color),
}));

/** The grid's tab stop: the ticked swatch, else the first. */
const gridStop = (el: HTMLElement | null) => el?.querySelector<HTMLElement>('[tabindex="0"]');

type Opened = { at: { x: number; y: number }; from: HTMLElement | null };

/** Where saving stands: nothing asked, waiting on Google, or waiting on the user to allow it. */
type Saving = "idle" | "saving" | "needs_access";

function ColorPopover({
  calendar,
  at,
  returnFocus,
  saving,
  authorizing,
  onChoose,
  onAllow,
  onCancelAllow,
  onClose,
}: {
  calendar: CalendarInfo;
  at: Opened["at"];
  returnFocus: HTMLElement | null;
  saving: Saving;
  authorizing: boolean;
  onChoose(color: string): void;
  onAllow(): void;
  onCancelAllow(): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { pos } = usePopover({
    ref,
    at,
    onClose,
    // Allowing opens the browser: stay open to say so, and for when the user comes back.
    closeOnBlur: !authorizing,
    focusIn: gridStop,
    returnFocus,
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key !== "Tab") return;
    e.preventDefault();
    e.stopPropagation();
    // The grid, then the note's buttons, round again.
    const stops = [
      gridStop(ref.current),
      ...(ref.current?.querySelectorAll<HTMLElement>(".cal-color__note button") ?? []),
    ].filter((el): el is HTMLElement => !!el && !(el as HTMLButtonElement).disabled);
    const at = stops.indexOf(document.activeElement as HTMLElement);
    const step = e.shiftKey ? stops.length - 1 : 1;
    stops[(at + step) % stops.length]?.focus();
  };

  return createPortal(
    <div
      ref={ref}
      className="label-color cal-color popover-surface"
      role="dialog"
      aria-label={`Colour of ${calendar.summary}`}
      data-owns-keys=""
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <SwatchGrid
        swatches={SWATCHES}
        value={calendarColor(calendar)}
        onChoose={onChoose}
        columns={6}
      />
      {/* One line, always there, so asking for access doesn't move anything. */}
      <div className="cal-color__note" role="status">
        {saving === "needs_access" ? (
          <>
            <span>
              {authorizing
                ? "Finish in your browser…"
                : "Allow Pheeme to change colours on Google."}
            </span>
            {authorizing ? (
              <Button size="sm" variant="ghost" onClick={onCancelAllow}>
                Cancel
              </Button>
            ) : (
              <Button size="sm" onClick={onAllow}>
                Allow
              </Button>
            )}
          </>
        ) : (
          <span>
            {saving === "saving" ? "Saving to Google Calendar…" : "Shows on all your devices."}
          </span>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Owns a calendar's colour picker: the palette button on its row, and `openAt` for a right-click.
 * The sign-in to allow recolouring lives here, not in the popover, so it carries on if the popover
 * closes meanwhile.
 */
export function useCalendarColor(accountId: string, calendar: CalendarInfo) {
  const [open, setOpen] = useState<Opened | null>(null);
  const [saving, setSaving] = useState<Saving>("idle");
  // The colour to save once the account allows it.
  const [pending, setPending] = useState<string | null>(null);
  const { state: signIn, start, cancel } = useSignIn();

  const save = async (color: string) => {
    setSaving("saving");
    try {
      await useCalendarStore.getState().setColor(accountId, calendar.id, color);
      setSaving("idle");
      setPending(null);
      setOpen(null);
    } catch (e) {
      if (toCommandError(e).code === "missing_scope") {
        setPending(color);
        setSaving("needs_access");
        return;
      }
      setSaving("idle");
      setPending(null);
      toastError(e);
    }
  };

  // Allowed: save the colour that was waiting. Refused or cancelled in the browser: say so.
  useEffect(() => {
    if (signIn.phase === "connected" && pending) void save(pending);
    else if (signIn.phase === "failed") toastError(signIn.error);
    // Only a change of phase acts; `save` and `pending` are read as they are then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signIn.phase]);

  const close = () => {
    setOpen(null);
    // Closed before allowing: forget the colour, unless the browser is still asking.
    if (signIn.phase !== "authorizing") {
      setPending(null);
      setSaving("idle");
    }
  };

  const popover = open && (
    <ColorPopover
      calendar={calendar}
      at={open.at}
      returnFocus={open.from}
      saving={saving}
      authorizing={signIn.phase === "authorizing"}
      onChoose={(color) => void save(color)}
      onAllow={() => void start({ kind: "calendarColors", accountId })}
      onCancelAllow={() => {
        cancel();
        setPending(null);
        setSaving("idle");
      }}
      onClose={close}
    />
  );

  return {
    open: open !== null,
    openAt: (at: Opened["at"], from: HTMLElement | null) => setOpen({ at, from }),
    popover,
  };
}

/** The row's palette button. */
export function CalendarColorButton({
  name,
  open,
  onOpen,
}: {
  name: string;
  open: boolean;
  onOpen(at: Opened["at"], from: HTMLElement): void;
}) {
  return (
    <IconButton
      size="sm"
      className="cal-sidebar__color"
      label={`Colour of ${name}`}
      icon={<Palette />}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={(e) => onOpen(below(e.currentTarget), e.currentTarget)}
    />
  );
}
