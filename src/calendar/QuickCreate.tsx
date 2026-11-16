// The quick-create popover: a new event's title, time and calendar, beside the slot picked on the
// grid (or in the middle, from `c` and Create). Enter saves; More options opens the editor.
import { X } from "lucide-react";
import { type FormEvent, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { placeBeside } from "../components/ui/placement";
import { inPicker } from "../components/ui/Picker";
import { TextInput } from "../components/ui/TextInput";
import { useDismiss } from "../components/ui/usePopover";
import { cancelDraft, openDraftInEditor, saveDraft, updateDraft } from "./actions";
import { noteDismiss } from "./drag";
import { DRAFT_ID, useEditStore } from "./editStore";
import { CalendarSelect, TimeFields } from "./EventFields";
import "../components/ui/Surface.css";

/** The draft's block on the grid, if it's drawn. */
function draftBlock(): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>("[data-event-key]")].find((el) =>
      el.dataset.eventKey?.endsWith(`\n${DRAFT_ID}`),
    ) ?? null
  );
}

export function QuickCreate() {
  const ready = useEditStore((s) => s.draft?.phase === "ready");
  return ready ? <QuickCreateBody /> : null;
}

function QuickCreateBody() {
  const form = useEditStore((s) => s.draft!.form);
  const ref = useRef<HTMLFormElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [saving, setSaving] = useState(false);

  // Beside the new event's block, like the event popover; centred when it isn't on screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const at = draftBlock()?.getBoundingClientRect() ?? null;
    const { left, top } = placeBeside(at, box, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
  }, [form]);

  useDismiss(ref, {
    onOutside: (e) => {
      noteDismiss(e);
      cancelDraft();
    },
    // Its own date, time and calendar pickers open outside it.
    ignore: (target) =>
      (target as Element).closest?.('[role="dialog"]') != null || inPicker(target),
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    await saveDraft();
    setSaving(false);
  };

  return (
    <form
      ref={ref}
      className="cal-pop cal-quick popover-surface"
      role="dialog"
      aria-label="New event"
      data-owns-keys=""
      style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}
      onSubmit={(e) => void submit(e)}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        cancelDraft();
      }}
    >
      <div className="cal-pop__head">
        <TextInput
          className="cal-quick__title"
          placeholder="Add title"
          aria-label="Title"
          autoFocus
          value={form.summary}
          onChange={(e) => updateDraft({ ...form, summary: e.currentTarget.value })}
        />
        <IconButton size="sm" label="Close" icon={<X />} onClick={cancelDraft} />
      </div>
      <TimeFields compact form={form} onChange={updateDraft} />
      <CalendarSelect form={form} onChange={updateDraft} />
      <div className="cal-quick__actions">
        <Button size="sm" variant="ghost" onClick={openDraftInEditor}>
          More options
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
