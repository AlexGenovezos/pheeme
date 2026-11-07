// The create / edit / delete label dialogs: modal, like Settings (scrim, focus trap, Esc closes, focus returns).
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "../components/ui/Button";
import { TextInput } from "../components/ui/TextInput";
import { registry } from "../keyboard/registry";
import {
  createLabel,
  deleteLabel,
  deleteLabelPreview,
  type LabelDeletePreview,
  type LabelInfo,
  toCommandError,
  updateLabel,
} from "../lib/tauri";
import { applyLabel, moveTo } from "../mail/actions";
import { useLabelStore } from "../store/labelStore";
import { type LabelDialogSpec, useLabelDialogStore } from "./dialogStore";
import "./labels.css";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const NO_LABELS: LabelInfo[] = [];

/** Why `name` (a full path) can't be a label name, or null. */
function nameProblem(name: string): string | null {
  if (!name) return "Enter a name.";
  if (name.startsWith("/") || name.endsWith("/") || name.split("/").some((s) => s.trim() === ""))
    return "A label name can't start or end with “/” or have an empty part.";
  return null;
}

/** The modal shell: scrim, focus trap, Esc, and focus back to whatever opened it. */
function Modal({
  title,
  titleId,
  returnTo,
  onClose,
  children,
}: {
  title: string;
  titleId: string;
  returnTo?: HTMLElement | null;
  onClose(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [returnFocus] = useState(() => {
    const opener = document.activeElement as HTMLElement | null;
    // A closing picker's own field is about to unmount: prefer what it saved, if it's still on the page.
    return returnTo?.isConnected ? returnTo : opener?.isConnected ? opener : null;
  });

  // While the dialog is open, keys belong to it.
  useEffect(() => registry.suspend(), []);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>("[data-autofocus]");
    (first ?? ref.current)?.focus();
    return () => {
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [returnFocus]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === ref.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="label-dialog-scrim"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        className="label-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-labelledby={titleId}
        tabIndex={-1}
        data-owns-keys=""
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="label-dialog__title">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

function splitPath(path: string): { parent: string | null; leaf: string } {
  const cut = path.lastIndexOf("/");
  return cut < 0
    ? { parent: null, leaf: path }
    : { parent: path.slice(0, cut), leaf: path.slice(cut + 1) };
}

function LabelForm({ spec, onClose }: { spec: LabelDialogSpec; onClose(): void }) {
  const { accountId } = spec;
  const all = useLabelStore((s) => s.labels[accountId] ?? NO_LABELS);
  const editing = spec.mode === "edit" ? all.find((l) => l.id === spec.labelId) : undefined;
  const id = useId();

  const parents = useMemo(() => {
    const names = all
      .filter((l) => l.type === "user" && l.id !== editing?.id)
      .map((l) => l.name)
      .filter((n) => !editing || !n.startsWith(`${editing.name}/`));
    return names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [all, editing]);

  const [initial] = useState(() => {
    if (spec.mode === "edit") return editing ? splitPath(editing.name) : { parent: null, leaf: "" };
    const prefill = spec.name ?? "";
    const split = splitPath(prefill);
    if (split.parent !== null && all.some((l) => l.name === split.parent)) return split;
    return { parent: spec.parent ?? null, leaf: prefill };
  });
  const [leaf, setLeaf] = useState(initial.leaf);
  const [nested, setNested] = useState(initial.parent !== null);
  const [parent, setParent] = useState(initial.parent ?? parents[0] ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // A parent the label already has but that isn't a label of its own still shows in the select.
  const parentOptions = parent && !parents.includes(parent) ? [parent, ...parents] : parents;
  const canNest = parentOptions.length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const trimmed = leaf.trim();
    const full = nested && parent ? `${parent}/${trimmed}` : trimmed;
    const problem = trimmed ? nameProblem(full) : nameProblem("");
    if (problem) return setError(problem);
    if (all.some((l) => l.id !== editing?.id && l.name.toLowerCase() === full.toLowerCase()))
      return setError(`A label named "${full}" already exists.`);
    if (editing && full === editing.name) return onClose();
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await updateLabel(accountId, editing.id, { name: full });
      } else {
        const created = await createLabel(accountId, full, null);
        useLabelStore.setState((s) => ({
          labels: {
            ...s.labels,
            [accountId]: [
              ...(s.labels[accountId] ?? []).filter((l) => l.id !== created.id),
              created,
            ],
          },
        }));
        if (spec.mode === "create" && spec.applyTo?.length && spec.move)
          void moveTo(accountId, spec.applyTo, created.id);
        else if (spec.mode === "create" && spec.applyTo?.length)
          void applyLabel(accountId, created.id, true, spec.applyTo, { evenIfGone: true });
      }
    } catch (err) {
      setSaving(false);
      setError(toCommandError(err).message);
      return;
    }
    onClose();
  };

  const verb = spec.mode === "edit" ? "Save" : "Create";
  return (
    <form className="label-dialog__form" onSubmit={submit} noValidate>
      <label className="label-dialog__field" htmlFor={`${id}-name`}>
        Name
      </label>
      <TextInput
        id={`${id}-name`}
        data-autofocus=""
        value={leaf}
        invalid={error !== null}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => {
          setLeaf(e.target.value);
          setError(null);
        }}
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="label-dialog__error">
          {error}
        </p>
      )}
      <label className="label-dialog__check">
        <input
          type="checkbox"
          checked={nested && canNest}
          disabled={!canNest}
          onChange={(e) => setNested(e.target.checked)}
        />
        Nest label under
      </label>
      <select
        className="label-dialog__select"
        aria-label="Parent label"
        disabled={!nested || !canNest}
        value={parent}
        onChange={(e) => setParent(e.target.value)}
      >
        {parentOptions.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <div className="label-dialog__actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {verb}
        </Button>
      </div>
    </form>
  );
}

function deleteBody(preview: LabelDeletePreview): string {
  const parts: string[] = [];
  if (preview.threads !== null)
    parts.push(`It comes off ${preview.threads} conversation${preview.threads === 1 ? "" : "s"}.`);
  parts.push("The conversations themselves aren't deleted.");
  const k = preview.sublabels.length;
  if (k > 0) parts.push(`Its ${k} ${k === 1 ? "sublabel is" : "sublabels are"} deleted too.`);
  return parts.join(" ");
}

function DeleteForm({
  accountId,
  labelId,
  onClose,
}: {
  accountId: string;
  labelId: string;
  onClose(): void;
}) {
  const [preview, setPreview] = useState<LabelDeletePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    deleteLabelPreview(accountId, labelId).then(
      (p) => live && setPreview(p),
      // The count is a courtesy: deleting still works without it.
      () => live && setPreview({ threads: null, sublabels: [] }),
    );
    return () => {
      live = false;
    };
  }, [accountId, labelId]);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteLabel(accountId, labelId);
    } catch (err) {
      setBusy(false);
      setError(toCommandError(err).message);
      return;
    }
    onClose();
  };

  return (
    <div className="label-dialog__form">
      <p className="label-dialog__body">
        {preview ? deleteBody(preview) : "Counting conversations…"}
      </p>
      {error && (
        <p role="alert" className="label-dialog__error">
          {error}
        </p>
      )}
      <div className="label-dialog__actions">
        <Button data-autofocus="" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" disabled={!preview || busy} onClick={() => void confirm()}>
          Delete
        </Button>
      </div>
    </div>
  );
}

/** Renders the open label dialog, if any. Mount once. */
export function LabelDialogHost() {
  const dialog = useLabelDialogStore((s) => s.dialog);
  const close = useLabelDialogStore((s) => s.close);
  const labels = useLabelStore((s) =>
    dialog
      ? s.labels[dialog.kind === "label" ? dialog.spec.accountId : dialog.accountId]
      : undefined,
  );
  const titleId = useId();
  if (!dialog) return null;
  if (dialog.kind === "label") {
    const title = dialog.spec.mode === "create" ? "New label" : "Edit label";
    return (
      <Modal
        key={dialog.seq}
        title={title}
        titleId={titleId}
        returnTo={dialog.spec.returnFocus}
        onClose={close}
      >
        <LabelForm spec={dialog.spec} onClose={close} />
      </Modal>
    );
  }
  const name = labels?.find((l) => l.id === dialog.labelId)?.name ?? "";
  const leaf = name.slice(name.lastIndexOf("/") + 1);
  return (
    <Modal
      key={dialog.seq}
      title={`Delete "${leaf}"?`}
      titleId={titleId}
      returnTo={dialog.returnFocus}
      onClose={close}
    >
      <DeleteForm accountId={dialog.accountId} labelId={dialog.labelId} onClose={close} />
    </Modal>
  );
}
