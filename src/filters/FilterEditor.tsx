// The filter editor: Gmail web's filter form on one page. What mail it matches (the search
// options), what it does (the actions), and Also apply filter to the matching conversations.
// Every field is there from the first frame; one that needs a tick first (the label picker under
// Apply the label, say) stays disabled until it's ticked, so nothing moves while you fill it in.
import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { TextInput } from "../components/ui/TextInput";
import { addCreatedLabel } from "../labels/create";
import {
  createFilter,
  createLabel,
  type FilterEntry,
  filterMatches,
  forwardingAddresses,
  type LabelInfo,
  replaceFilter,
  toCommandError,
} from "../lib/tauri";
import { toast } from "../components/ui/Toast";
import { useAccountStore } from "../store/accountStore";
import { useLabelStore } from "../store/labelStore";
import { type FilterEditorSpec, useFilterEditorStore } from "./editorStore";
import {
  applyExistingLabel,
  CATEGORY_CHOICES,
  changesExisting,
  criteriaOf,
  type FilterForm,
  formOf,
  NEW_LABEL,
  SIZE_UNITS,
  specOf,
} from "./form";
import "../components/ui/Surface.css";
import "./filters.css";

const NO_LABELS: LabelInfo[] = [];
const SIZE_COMPARISONS: { value: FilterForm["sizeComparison"]; label: string }[] = [
  { value: "larger", label: "greater than" },
  { value: "smaller", label: "less than" },
];

/** Forwarding addresses: loading, the verified ones, or why they couldn't be read. */
type Forwarding = { kind: "loading" } | { kind: "ready"; list: string[] } | { kind: "error" };

/** The match count waits this long after typing stops, so it isn't asked for every key. */
const COUNT_DELAY_MS = 300;

function useForwarding(accountId: string): Forwarding {
  const [state, setState] = useState<Forwarding>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    forwardingAddresses(accountId).then(
      (list) => live && setState({ kind: "ready", list }),
      () => live && setState({ kind: "error" }),
    );
    return () => {
      live = false;
    };
  }, [accountId]);
  return state;
}

/** How many conversations the search options match now (undefined while it's counted). */
function useMatchCount(accountId: string, form: FilterForm): number | null | undefined {
  const criteria = criteriaOf(form);
  const key = criteria ? JSON.stringify(criteria) : null;
  const [count, setCount] = useState<{ key: string; value: number | null }>();
  useEffect(() => {
    if (key === null) return;
    let live = true;
    const timer = setTimeout(() => {
      filterMatches(accountId, JSON.parse(key)).then(
        (value) => live && setCount({ key, value }),
        () => live && setCount({ key, value: null }),
      );
    }, COUNT_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [accountId, key]);
  if (key === null) return null;
  return count?.key === key ? count.value : undefined;
}

function FilterEditorForm({ editor, onClose }: { editor: FilterEditorSpec; onClose(): void }) {
  const { accountId, filterId } = editor;
  const id = useId();
  const allLabels = useLabelStore((s) => s.labels[accountId] ?? NO_LABELS);
  const [form, setForm] = useState(() => formOf(editor.spec ?? {}));
  const [applyExisting, setApplyExisting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const forwarding = useForwarding(accountId);
  const count = useMatchCount(accountId, form);

  const set = <K extends keyof FilterForm>(key: K, value: FilterForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setError(null);
  };

  const labelOptions = useMemo(() => {
    const user = allLabels
      .filter((l) => l.type === "user")
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
      .map((l) => ({ value: l.id, label: l.name }));
    return [...user, { value: NEW_LABEL, label: "New label…" }];
  }, [allLabels]);

  const forwardList = forwarding.kind === "ready" ? forwarding.list : [];
  const canForward = forwardList.length > 0;
  const forwardHint =
    forwarding.kind === "loading"
      ? "Loading forwarding addresses…"
      : forwarding.kind === "error"
        ? "Couldn't read this account's forwarding addresses."
        : canForward
          ? "Only addresses Gmail has verified."
          : "Add and verify a forwarding address in Gmail's settings first.";
  // Keep a forward address the filter already has, even before the list loads.
  const forwardOptions = (
    form.forward && !forwardList.includes(form.forward)
      ? [form.forward, ...forwardList]
      : forwardList
  ).map((a) => ({ value: a, label: a }));

  const existingOn = changesExisting(form);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const newLabel = form.applyLabel && form.label === NEW_LABEL ? form.newLabel.trim() : "";
    const labelId = form.label === NEW_LABEL ? (newLabel ? NEW_LABEL : null) : form.label || null;
    const checked = specOf(form, labelId);
    if ("problem" in checked) return setError(checked.problem);
    setSaving(true);
    setError(null);
    try {
      let spec = checked.spec;
      if (newLabel) {
        const existing = allLabels.find((l) => l.name.toLowerCase() === newLabel.toLowerCase());
        const label = existing ?? (await createLabel(accountId, newLabel, null));
        if (!existing) addCreatedLabel(accountId, label);
        spec = { ...spec, label: label.id };
        setForm((f) => ({ ...f, label: label.id, newLabel: "" }));
      }
      const apply = applyExisting && existingOn;
      const saved: FilterEntry = filterId
        ? await replaceFilter(accountId, filterId, spec, apply)
        : await createFilter(accountId, spec, apply);
      editor.onSaved?.(saved, filterId);
      toast({ title: filterId ? "Filter saved" : "Filter created" });
    } catch (err) {
      setSaving(false);
      setError(toCommandError(err).message);
      return;
    }
    onClose();
  };

  const text = (label: string, key: "from" | "to" | "subject" | "query" | "negatedQuery") => (
    <>
      <label className="filter-editor__label" htmlFor={`${id}-${key}`}>
        {label}
      </label>
      <TextInput
        id={`${id}-${key}`}
        value={form[key]}
        data-autofocus={key === "from" ? "" : undefined}
        onChange={(e) => set(key, e.target.value)}
      />
    </>
  );
  const check = (
    key:
      | "skipInbox"
      | "markRead"
      | "star"
      | "trash"
      | "neverSpam"
      | "hasAttachment"
      | "excludeChats",
    label: string,
  ) => (
    <label className="filter-editor__check">
      <input type="checkbox" checked={form[key]} onChange={(e) => set(key, e.target.checked)} />
      {label}
    </label>
  );
  // An action with a control of its own: the control is there from the start, disabled until ticked.
  const withControl = (
    key: "applyLabel" | "forwardOn" | "categorize",
    label: string,
    control: ReactNode,
    opts: { disabled?: boolean; hint?: string } = {},
  ) => (
    <div className="filter-editor__action">
      <label className="filter-editor__check">
        <input
          type="checkbox"
          checked={form[key]}
          disabled={opts.disabled}
          onChange={(e) => set(key, e.target.checked)}
        />
        {label}
      </label>
      <div className="filter-editor__action-control">{control}</div>
      {opts.hint !== undefined && <p className="filter-editor__hint">{opts.hint}</p>}
    </div>
  );

  const accounts = useAccountStore((s) => s.accounts);
  const email = accounts.find((a) => a.id === accountId)?.email ?? "";

  return (
    <form className="filter-editor__form" onSubmit={submit} noValidate>
      <p className="filter-editor__account">{email}</p>
      <fieldset className="filter-editor__section">
        <legend className="filter-editor__legend">Matches</legend>
        <div className="filter-editor__grid">
          {text("From", "from")}
          {text("To", "to")}
          {text("Subject", "subject")}
          {text("Has the words", "query")}
          {text("Doesn't have", "negatedQuery")}
          <span className="filter-editor__label">Size</span>
          <div className="filter-editor__size">
            <Select
              aria-label="Size is"
              value={form.sizeComparison}
              options={SIZE_COMPARISONS}
              onChange={(value) => set("sizeComparison", value)}
            />
            <TextInput
              aria-label="Size"
              inputMode="decimal"
              value={form.size}
              onChange={(e) => set("size", e.target.value)}
            />
            <Select
              aria-label="Size unit"
              value={form.sizeUnit}
              options={SIZE_UNITS.map((u) => ({ value: u, label: u }))}
              onChange={(value) => set("sizeUnit", value)}
            />
          </div>
          <span />
          <div className="filter-editor__checks">
            {check("hasAttachment", "Has attachment")}
            {check("excludeChats", "Don't include chats")}
          </div>
        </div>
      </fieldset>
      <fieldset className="filter-editor__section">
        <legend className="filter-editor__legend">When a message matches</legend>
        <div className="filter-editor__actions-list">
          {check("skipInbox", "Skip the Inbox (Archive it)")}
          {check("markRead", "Mark as read")}
          {check("star", "Star it")}
          {withControl(
            "applyLabel",
            "Apply the label:",
            <>
              <Select
                aria-label="Label to apply"
                disabled={!form.applyLabel}
                value={form.label}
                placeholder="Choose label…"
                options={labelOptions}
                onChange={(value) => set("label", value)}
              />
              <TextInput
                aria-label="New label name"
                placeholder="New label name"
                disabled={!form.applyLabel || form.label !== NEW_LABEL}
                value={form.newLabel}
                onChange={(e) => set("newLabel", e.target.value)}
              />
            </>,
          )}
          {withControl(
            "forwardOn",
            "Forward it to:",
            <Select
              aria-label="Forward to"
              disabled={!form.forwardOn || !canForward}
              value={form.forward}
              placeholder={canForward ? "Choose an address…" : "No forwarding address"}
              options={forwardOptions}
              onChange={(value) => set("forward", value)}
            />,
            { disabled: !canForward && !form.forwardOn, hint: forwardHint },
          )}
          {check("trash", "Delete it")}
          {check("neverSpam", "Never send it to Spam")}
          <label className="filter-editor__check">
            <input
              type="checkbox"
              checked={form.alwaysImportant}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  alwaysImportant: e.target.checked,
                  neverImportant: e.target.checked ? false : f.neverImportant,
                }))
              }
            />
            Always mark it as important
          </label>
          <label className="filter-editor__check">
            <input
              type="checkbox"
              checked={form.neverImportant}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  neverImportant: e.target.checked,
                  alwaysImportant: e.target.checked ? false : f.alwaysImportant,
                }))
              }
            />
            Never mark it as important
          </label>
          {withControl(
            "categorize",
            "Categorize as:",
            <Select
              aria-label="Category"
              disabled={!form.categorize}
              value={form.category}
              options={CATEGORY_CHOICES}
              onChange={(value) => set("category", value)}
            />,
          )}
        </div>
      </fieldset>
      <label className="filter-editor__check filter-editor__existing">
        <input
          type="checkbox"
          checked={applyExisting && existingOn}
          disabled={!existingOn}
          onChange={(e) => setApplyExisting(e.target.checked)}
        />
        <span>
          {applyExistingLabel(count)}
          <span className="filter-editor__hint">
            {existingOn
              ? "Changes the conversations already there, in Gmail too."
              : "Choose an action that changes mail (forwarding only affects new mail)."}
          </span>
        </span>
      </label>
      <p id={`${id}-error`} role="alert" className="filter-editor__error">
        {error ?? ""}
      </p>
      <div className="filter-editor__buttons">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {filterId ? "Save filter" : "Create filter"}
        </Button>
      </div>
    </form>
  );
}

/** Renders the open filter editor, if any. Mount once, after Settings (it opens over it). */
export function FilterEditorHost() {
  const editor = useFilterEditorStore((s) => s.editor);
  const close = useFilterEditorStore((s) => s.close);
  const titleId = useId();
  if (!editor) return null;
  return (
    <Modal
      key={editor.seq}
      title={editor.filterId ? "Edit filter" : "Create a filter"}
      titleId={titleId}
      onClose={close}
      scrimClassName="filter-editor-scrim dialog-scrim"
      className="filter-editor dialog-surface"
      titleClassName="filter-editor__title"
    >
      <FilterEditorForm editor={editor} onClose={close} />
    </Modal>
  );
}
