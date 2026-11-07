// "Label as…" and "Move to…": a searchable popover over an account's labels.
import { Check, Inbox, Minus, Plus, Search, Tags, Trash2 } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "../components/ui/Toast";
import { createLabel, type LabelInfo, toCommandError } from "../lib/tauri";
import { cx } from "../lib/utils";
import { applyLabel, moveOrigin, moveTo } from "../mail/actions";
import { useLabelStore } from "../store/labelStore";
import { chipColors } from "./palette";
import { type Membership, type PickerSpec, usePickerStore } from "./pickerStore";
import { revealLabels } from "./reveal";
import { buildLabelTree, type LabelNode } from "./tree";
import "./labels.css";

type Option =
  | { kind: "label"; label: LabelInfo }
  | { kind: "inbox" | "trash" | "manage" }
  | { kind: "create"; name: string };

/** User labels in sidebar order (parents before their sublabels), synthetic parents left out. */
function inTreeOrder(labels: LabelInfo[]): LabelInfo[] {
  const out: LabelInfo[] = [];
  const walk = (nodes: LabelNode[]) => {
    for (const node of nodes) {
      if (node.label) out.push(node.label);
      walk(node.children);
    }
  };
  walk(buildLabelTree(labels));
  return out;
}

const tick = (m: Membership) => (m === "all" ? "true" : m === "some" ? "mixed" : "false");

function TickIcon({ membership }: { membership: Membership }) {
  if (membership === "all") return <Check aria-hidden="true" />;
  if (membership === "some") return <Minus aria-hidden="true" />;
  return null;
}

function LabelDot({ label }: { label: LabelInfo }) {
  const colors = chipColors(label);
  return (
    <span
      className={cx("label-picker__dot", !colors && "label-picker__dot--none")}
      style={colors ? { background: colors.background } : undefined}
      aria-hidden="true"
    />
  );
}

/** Adds a label just created to the store at once, so it lists (and names its chips) before the next refresh. */
function remember(label: LabelInfo) {
  useLabelStore.setState((s) => ({
    labels: {
      ...s.labels,
      [label.accountId]: [
        ...(s.labels[label.accountId] ?? []).filter((l) => l.id !== label.id),
        label,
      ],
    },
  }));
}

const NO_LABELS: LabelInfo[] = [];

export function LabelPicker({ spec, onClose }: { spec: PickerSpec; onClose(): void }) {
  const { mode, accountId, keys, at } = spec;
  const createOnly = keys.length === 0;
  const all = useLabelStore((s) => s.labels[accountId] ?? NO_LABELS);
  const userLabels = useLabelStore((s) => s.userLabels(accountId));
  const ordered = useMemo(() => inTreeOrder(userLabels), [userLabels]);
  const [origin] = useState(() => (mode === "move" ? moveOrigin(accountId) : null));
  const [membership, setMembership] = useState(() => new Map(spec.membership));
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [creating, setCreating] = useState(false);
  const [pos, setPos] = useState(at);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const options = useMemo((): Option[] => {
    const q = query.trim().toLowerCase();
    const matches = (text: string) => text.toLowerCase().includes(q);
    const list: Option[] = [];
    if (!createOnly) {
      if (mode === "move" && origin !== "INBOX" && matches("Inbox")) list.push({ kind: "inbox" });
      for (const label of ordered)
        if (label.id !== origin && matches(label.name)) list.push({ kind: "label", label });
      if (mode === "move" && matches("Trash")) list.push({ kind: "trash" });
    }
    const name = query.trim();
    if (name && !all.some((l) => l.name.toLowerCase() === q)) list.push({ kind: "create", name });
    list.push({ kind: "manage" });
    return list;
  }, [all, createOnly, mode, ordered, origin, query]);

  // Keep the popover inside the viewport once its size is known.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(at.x, window.innerWidth - width));
    const y = Math.max(0, Math.min(at.y, window.innerHeight - height));
    if (x !== at.x || y !== at.y) setPos({ x, y });
  }, [at]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onBlur = () => onClose();
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onBlur);
      previous?.focus?.();
    };
  }, [onClose]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  /**
   * Ticks `labelId` to `next` now and applies it to the conversations the picker opened for, even those its own
   * changes have since taken out of the list. A refusal puts the tick back, unless another tick has replaced it.
   */
  const setTick = (labelId: string, next: Membership, add: boolean) => {
    const previous = membership.get(labelId) ?? "none";
    setMembership((m) => new Map(m).set(labelId, next));
    void applyLabel(accountId, labelId, add, keys, { evenIfGone: true }).then((ok) => {
      if (!ok)
        setMembership((m) => (m.get(labelId) === next ? new Map(m).set(labelId, previous) : m));
    });
  };

  const toggle = (label: LabelInfo) => {
    const add = (membership.get(label.id) ?? "none") !== "all";
    setTick(label.id, add ? "all" : "none", add);
  };

  const create = async (name: string) => {
    if (creating) return;
    setCreating(true);
    let label: LabelInfo;
    try {
      label = await createLabel(accountId, name, null);
    } catch (error) {
      setCreating(false);
      toast({ title: toCommandError(error).message, tone: "danger" });
      return;
    }
    remember(label);
    setCreating(false);
    if (createOnly) {
      onClose();
      toast({ title: `Created "${label.name}"` });
    } else if (mode === "move") {
      onClose();
      void moveTo(accountId, keys, label.id);
    } else {
      setQuery("");
      setActive(0);
      setTick(label.id, "all", true);
    }
  };

  const choose = (option: Option | undefined) => {
    if (!option) return;
    switch (option.kind) {
      case "label":
        if (mode === "label") return toggle(option.label);
        onClose();
        return void moveTo(accountId, keys, option.label.id);
      case "inbox":
      case "trash":
        onClose();
        return void moveTo(accountId, keys, option.kind === "inbox" ? "INBOX" : "TRASH");
      case "create":
        return void create(option.name);
      case "manage":
        onClose();
        return revealLabels();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const count = options.length;
    if (e.key === "ArrowDown") setActive((a) => (a + 1) % count);
    else if (e.key === "ArrowUp") setActive((a) => (a - 1 + count) % count);
    else if (e.key === "Enter") choose(options[active]);
    else if (e.key === "Escape") onClose();
    else if (e.key === "Tab") {
      /* keep focus in the picker */
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const title = createOnly ? "Create label" : mode === "label" ? "Label as" : "Move to";
  const listId = "label-picker-listbox";
  const row = (option: Option, i: number): ReactNode => {
    const ticks = mode === "label" && !createOnly && option.kind === "label";
    const state = ticks ? (membership.get(option.label.id) ?? "none") : null;
    const text =
      option.kind === "label"
        ? option.label.name
        : option.kind === "create"
          ? `Create "${option.name}"…`
          : option.kind === "inbox"
            ? "Inbox"
            : option.kind === "trash"
              ? "Trash"
              : "Manage labels";
    const icon =
      option.kind === "label" ? (
        <LabelDot label={option.label} />
      ) : option.kind === "create" ? (
        <Plus aria-hidden="true" />
      ) : option.kind === "inbox" ? (
        <Inbox aria-hidden="true" />
      ) : option.kind === "trash" ? (
        <Trash2 aria-hidden="true" />
      ) : (
        <Tags aria-hidden="true" />
      );
    return (
      <div
        key={option.kind === "label" ? option.label.id : option.kind}
        id={`label-picker-option-${i}`}
        role="option"
        aria-selected={i === active}
        aria-checked={state ? tick(state) : undefined}
        aria-disabled={(option.kind === "create" && creating) || undefined}
        data-index={i}
        title={option.kind === "label" ? option.label.name : undefined}
        className={cx("label-picker__option", option.kind === "manage" && "label-picker__footer")}
        onPointerMove={() => i !== active && setActive(i)}
        onClick={() => {
          setActive(i);
          choose(option);
        }}
      >
        {mode === "label" && !createOnly && (
          <span className="label-picker__check">{state && <TickIcon membership={state} />}</span>
        )}
        <span className="label-picker__icon">{icon}</span>
        <span className="label-picker__name">{text}</span>
      </div>
    );
  };

  return (
    <div
      ref={ref}
      className="label-picker"
      role="dialog"
      aria-label={title}
      data-owns-keys=""
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
      // Nothing else in the picker takes focus: keep it in the search field, so keys still work after a click.
      onMouseDown={(e) => e.target !== inputRef.current && e.preventDefault()}
    >
      <div className="label-picker__search">
        <Search aria-hidden="true" />
        <input
          ref={inputRef}
          className="label-picker__input"
          role="combobox"
          aria-label={createOnly ? "New label name" : "Search labels"}
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={options[active] ? `label-picker-option-${active}` : undefined}
          aria-autocomplete="list"
          placeholder={createOnly ? "New label name" : mode === "label" ? "Label as…" : "Move to…"}
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={title}
        className="label-picker__list"
      >
        {options.map(row)}
      </div>
    </div>
  );
}

/** Renders the open label picker, if any. Mount once. */
export function LabelPickerHost() {
  const spec = usePickerStore((s) => s.spec);
  if (!spec) return null;
  return <LabelPicker key={spec.seq} spec={spec} onClose={usePickerStore.getState().close} />;
}
