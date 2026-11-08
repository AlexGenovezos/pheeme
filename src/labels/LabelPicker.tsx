// "Label as…" and "Move to…": a searchable popover over an account's labels.
import { Check, Inbox, Minus, Plus, Search, Tags, Trash2 } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { createSubscriptionScope } from "../lib/subscriptions";
import { type LabelInfo, SYNC_EVENTS, type SyncAccountEvent } from "../lib/tauri";
import { cx } from "../lib/utils";
import { applyLabel, labelMembership, moveOrigin, moveTo, shownCategory } from "../mail/actions";
import { openCategoryMove } from "../mail/CategoryMoveDialog";
import { CATEGORIES, type MailboxRow } from "../mail/mailboxes";
import { useLabelStore } from "../store/labelStore";
import { openLabelDialog } from "./dialogStore";
import { chipColors } from "./palette";
import { type Membership, type PickerSpec, usePickerStore } from "./pickerStore";
import { revealLabels } from "./reveal";
import { buildLabelTree, type LabelNode } from "./tree";
import "./labels.css";

interface LabelOption {
  kind: "label";
  label: LabelInfo;
  /** How far the row steps in: one level per listed ancestor. */
  depth: number;
  /** Dimmed context before the name (a search match's parent path, with its `/`), or empty. */
  context: string;
  /** The name shown: the path below the nearest listed ancestor, or the leaf of a search match. */
  text: string;
}

type Option =
  | LabelOption
  | { kind: "category"; category: MailboxRow }
  | { kind: "inbox" | "trash" | "manage" }
  | { kind: "create"; name: string };

/** User labels in sidebar order, leaving out `skip` and synthetic parents; each steps in under the nearest one listed. */
function labelTreeOptions(labels: LabelInfo[], skip: string | null): LabelOption[] {
  const out: LabelOption[] = [];
  const walk = (nodes: LabelNode[], depth: number, under: string | null) => {
    for (const node of nodes) {
      if (node.label && node.label.id !== skip) {
        const text = under === null ? node.path : node.path.slice(under.length + 1);
        out.push({ kind: "label", label: node.label, depth, context: "", text });
        walk(node.children, depth + 1, node.path);
      } else walk(node.children, depth, under);
    }
  };
  walk(buildLabelTree(labels), 0, null);
  return out;
}

/** A search match: flat, its leaf after its dimmed parent path. */
function searchOption(label: LabelInfo): LabelOption {
  const cut = label.name.lastIndexOf("/");
  return {
    kind: "label",
    label,
    depth: 0,
    context: label.name.slice(0, cut + 1),
    text: label.name.slice(cut + 1),
  };
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

const NO_LABELS: LabelInfo[] = [];

export function LabelPicker({ spec, onClose }: { spec: PickerSpec; onClose(): void }) {
  const { mode, accountId, keys, at } = spec;
  const createOnly = keys.length === 0;
  const all = useLabelStore((s) => s.labels[accountId] ?? NO_LABELS);
  const userLabels = useLabelStore((s) => s.userLabels(accountId));
  const [origin] = useState(() => (mode === "move" ? moveOrigin(accountId) : null));
  // The category tab being shown isn't somewhere to move to.
  const [shown] = useState(() => (mode === "move" ? shownCategory() : null));
  const tree = useMemo(() => labelTreeOptions(userLabels, origin), [userLabels, origin]);
  const [membership, setMembership] = useState(() => new Map(spec.membership));
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // Labels whose tick is still on its way to Gmail; the ref guards synchronously, the state draws the row.
  const inFlight = useRef(new Set<string>());
  // Ticks started so far, and per label the count when its latest began: a re-read that started earlier is stale for it.
  const ticks = useRef({ count: 0, last: new Map<string, number>() });
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [pos, setPos] = useState(at);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // What had focus before the picker opened; the dialog it hands over to gives focus back there.
  const openerRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const options = useMemo((): Option[] => {
    const q = query.trim().toLowerCase();
    const matches = (text: string) => text.toLowerCase().includes(q);
    const list: Option[] = [];
    if (!createOnly) {
      if (mode === "move" && origin !== "INBOX" && matches("Inbox")) list.push({ kind: "inbox" });
      if (mode === "move")
        for (const category of CATEGORIES)
          if (category.labelId !== shown && matches(category.name))
            list.push({ kind: "category", category });
      if (!q) list.push(...tree);
      else for (const { label } of tree) if (matches(label.name)) list.push(searchOption(label));
      if (mode === "move" && matches("Trash")) list.push({ kind: "trash" });
    }
    const name = query.trim();
    if (name && !all.some((l) => l.name.toLowerCase() === q)) list.push({ kind: "create", name });
    list.push({ kind: "manage" });
    return list;
  }, [all, createOnly, mode, origin, query, shown, tree]);

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
    openerRef.current = previous;
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

  // Gmail can refuse a tick after its command resolved: the backend undoes it and says so. Re-read the ticks then.
  useEffect(() => {
    if (mode !== "label" || createOnly) return;
    // Re-reads can overlap: only the latest one applies, so a slower older one can't overwrite it.
    const seq = { latest: 0, live: true };
    const reread = async () => {
      const read = ++seq.latest;
      const since = ticks.current.count;
      const fresh = await labelMembership(accountId, keys, { fresh: true }).catch(() => null);
      if (!seq.live || read !== seq.latest || !fresh) return; // stale, or couldn't read: keep the ticks shown
      const keep = (id: string) =>
        inFlight.current.has(id) || (ticks.current.last.get(id) ?? -1) >= since;
      setMembership((m) => {
        const next = new Map(fresh);
        for (const [id, state] of m) if (keep(id)) next.set(id, state);
        return next;
      });
    };
    const scope = createSubscriptionScope();
    for (const event of [SYNC_EVENTS.outboxRejected, SYNC_EVENTS.messagesUpdated])
      scope
        .add(() =>
          listen<SyncAccountEvent>(event, ({ payload }) => {
            if (payload.accountId === accountId) void reread();
          }),
        )
        .catch((err: unknown) => console.warn("label picker listener failed", err));
    return () => {
      seq.live = false;
      scope.dispose();
    };
  }, [accountId, createOnly, keys, mode]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  /**
   * Ticks `labelId` to `next` now and applies it to the conversations the picker opened for, even those its own
   * changes have since taken out of the list. One tick per label at a time: the row is disabled until Gmail's queue
   * answers, so a refusal can put back exactly the state before it.
   */
  const setTick = (labelId: string, next: Membership, add: boolean) => {
    if (inFlight.current.has(labelId)) return;
    inFlight.current.add(labelId);
    ticks.current.last.set(labelId, ticks.current.count++);
    setBusy(new Set(inFlight.current));
    const previous = membership.get(labelId) ?? "none";
    setMembership((m) => new Map(m).set(labelId, next));
    void applyLabel(accountId, labelId, add, keys, { evenIfGone: true }).then((ok) => {
      inFlight.current.delete(labelId);
      setBusy(new Set(inFlight.current));
      if (!ok) setMembership((m) => new Map(m).set(labelId, previous));
    });
  };

  const toggle = (label: LabelInfo) => {
    const add = (membership.get(label.id) ?? "none") !== "all";
    setTick(label.id, add ? "all" : "none", add);
  };

  /** Hands the typed name to the new-label dialog, which labels the picker's conversations once it exists. */
  const create = (name: string) => {
    onClose();
    openLabelDialog({
      mode: "create",
      accountId,
      name,
      returnFocus: openerRef.current,
      applyTo: createOnly ? undefined : keys,
      move: mode === "move",
    });
  };

  const choose = (option: Option | undefined) => {
    if (!option) return;
    switch (option.kind) {
      case "label":
        if (mode === "label") return toggle(option.label);
        onClose();
        return void moveTo(accountId, keys, option.label.id);
      case "category":
        onClose();
        return openCategoryMove({ accountId, keys, category: option.category.labelId, at: pos });
      case "inbox":
      case "trash":
        onClose();
        return void moveTo(accountId, keys, option.kind === "inbox" ? "INBOX" : "TRASH");
      case "create":
        return create(option.name);
      case "manage":
        onClose();
        return revealLabels(accountId);
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
        ? option.text
        : option.kind === "create"
          ? `Create "${option.name}"…`
          : option.kind === "category"
            ? option.category.name
            : option.kind === "inbox"
              ? "Inbox"
              : option.kind === "trash"
                ? "Trash"
                : "Manage labels";
    const context = option.kind === "label" ? option.context : "";
    const icon =
      option.kind === "label" ? (
        <LabelDot label={option.label} />
      ) : option.kind === "create" ? (
        <Plus aria-hidden="true" />
      ) : option.kind === "category" ? (
        <option.category.icon aria-hidden="true" />
      ) : option.kind === "inbox" ? (
        <Inbox aria-hidden="true" />
      ) : option.kind === "trash" ? (
        <Trash2 aria-hidden="true" />
      ) : (
        <Tags aria-hidden="true" />
      );
    return (
      <div
        key={
          option.kind === "label"
            ? option.label.id
            : option.kind === "category"
              ? option.category.labelId
              : option.kind
        }
        id={`label-picker-option-${i}`}
        role="option"
        aria-label={option.kind === "label" ? option.label.name : undefined}
        aria-selected={i === active}
        aria-checked={state ? tick(state) : undefined}
        aria-disabled={(option.kind === "label" && busy.has(option.label.id)) || undefined}
        data-index={i}
        title={option.kind === "label" ? option.label.name : undefined}
        className={cx("label-picker__option", option.kind === "manage" && "label-picker__footer")}
        style={
          option.kind === "label" && option.depth
            ? ({ "--label-depth": option.depth } as CSSProperties)
            : undefined
        }
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
        <span className={cx("label-picker__name", context && "label-picker__name--path")}>
          {context && <span className="label-picker__context">{context}</span>}
          {context ? <span className="label-picker__leaf">{text}</span> : text}
        </span>
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
