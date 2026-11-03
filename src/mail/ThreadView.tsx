import { Forward, Reply, ReplyAll, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/Button";
import { Kbd } from "../components/ui/Kbd";
import { useKeybinding } from "../keyboard/useCommands";
import type { LabelInfo, ThreadDetail } from "../lib/tauri";
import { useLabelStore } from "../store/labelStore";
import { useThreadStore } from "../store/threadStore";
import { useUiStore } from "../store/uiStore";
import { MessageCard } from "./MessageCard";
import { composeLater, toggleLabel } from "./actions";
import { parseThreadKey } from "./mailboxes";
import "./mail.css";

/** Which messages are open. `seen` is every message already given its starting state. */
interface Expansion {
  key: string | null;
  seen: ReadonlySet<string>;
  open: ReadonlySet<string>;
}

/**
 * Messages start open when they're the last or unread, and each is decided once: opening the thread marks it
 * read, and that mustn't fold the cards the user is looking at. Messages that arrive later are decided the same way.
 */
function withNewMessages(state: Expansion, key: string, detail: ThreadDetail): Expansion {
  const base =
    state.key === key ? state : { key, seen: new Set<string>(), open: new Set<string>() };
  const fresh = detail.messages.filter((m) => !base.seen.has(m.id));
  if (fresh.length === 0 && base === state) return state;
  const seen = new Set(base.seen);
  const open = new Set(base.open);
  const lastId = detail.messages[detail.messages.length - 1]?.id;
  for (const m of fresh) {
    seen.add(m.id);
    if (m.unread || m.id === lastId) open.add(m.id);
  }
  return { key, seen, open };
}

function LabelChips({
  labels,
  onRemove,
}: {
  labels: LabelInfo[];
  onRemove(label: LabelInfo): void;
}) {
  if (labels.length === 0) return null;
  return (
    <ul className="thread-view__labels" aria-label="Labels">
      {labels.map((label) => (
        <li key={label.id} className="label-chip">
          {label.colorBackground && (
            <span
              className="label-chip__dot"
              style={{ backgroundColor: label.colorBackground }}
              aria-hidden="true"
            />
          )}
          <span className="label-chip__name">{label.name}</span>
          <button
            type="button"
            className="label-chip__remove"
            aria-label={`Remove label ${label.name}`}
            onClick={() => onRemove(label)}
          >
            <X aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ThreadView() {
  const openKey = useUiStore((s) => s.openThread);
  const detail = useThreadStore((s) => (openKey ? s.details.get(openKey) : undefined));
  const error = useThreadStore((s) => (openKey ? s.errors[openKey] : undefined));
  const load = useThreadStore((s) => s.load);
  const accountId = openKey ? parseThreadKey(openKey).accountId : "";
  const userLabels = useLabelStore((s) => s.userLabels(accountId));
  const scroller = useRef<HTMLDivElement>(null);
  const [expansion, setExpansion] = useState<Expansion>({
    key: null,
    seen: new Set(),
    open: new Set(),
  });

  useEffect(() => {
    if (openKey) void load(openKey);
  }, [openKey, load]);

  // A new conversation starts at the top.
  useEffect(() => {
    scroller.current?.scrollTo?.({ top: 0 });
  }, [openKey]);

  let current = expansion;
  if (openKey && detail) {
    current = withNewMessages(expansion, openKey, detail);
    if (current !== expansion) setExpansion(current);
  }

  const toggle = (id: string) =>
    setExpansion((s) => {
      const open = new Set(s.open);
      if (!open.delete(id)) open.add(id);
      return { ...s, open };
    });

  let content;
  if (!openKey) {
    content = (
      <div className="pane-empty">
        <p className="pane-empty__title">No conversation selected</p>
        <EmptyHint />
      </div>
    );
  } else if (detail) {
    const onThread = new Set(detail.messages.flatMap((m) => m.labelIds));
    const chips = userLabels.filter((l) => onThread.has(l.id));
    const subject = detail.thread.subject || "(no subject)";
    content = (
      <div className="thread-view">
        <h2 className="thread-view__subject selectable">{subject}</h2>
        <LabelChips
          labels={chips}
          onRemove={(label) => void toggleLabel(accountId, label.id, [openKey])}
        />
        <div className="thread-view__messages">
          {detail.messages.map((m) => (
            <MessageCard
              key={m.id}
              message={m}
              accountId={detail.thread.accountId}
              expanded={current.open.has(m.id)}
              onToggle={() => toggle(m.id)}
            />
          ))}
        </div>
        <div className="thread-view__replies">
          <Button icon={<Reply />} onClick={composeLater}>
            Reply
          </Button>
          <Button icon={<ReplyAll />} onClick={composeLater}>
            Reply all
          </Button>
          <Button icon={<Forward />} onClick={composeLater}>
            Forward
          </Button>
        </div>
      </div>
    );
  } else if (error) {
    content = (
      <div className="pane-empty">
        <p className="pane-empty__title">
          {error.code === "not_found"
            ? "This conversation isn't available any more."
            : error.message}
        </p>
        {error.code !== "not_found" && (
          <Button size="sm" onClick={() => void load(openKey)}>
            Try again
          </Button>
        )}
      </div>
    );
  } else {
    content = null; // Reads from the local cache, so this is a blink. No spinner.
  }

  return (
    <div className="view-pane__scroll" ref={scroller}>
      {content}
    </div>
  );
}

/** "J and K move through the list. ⌘K shows every command.", with the user's keys. */
function EmptyHint() {
  const next = useKeybinding("list.next", "j");
  const previous = useKeybinding("list.previous", "k");
  const palette = useKeybinding("palette.toggle", "mod+k");
  return (
    <p className="pane-empty__hint">
      {next && previous && (
        <>
          <Kbd shortcut={next} /> and <Kbd shortcut={previous} /> move through the list.{" "}
        </>
      )}
      {palette && (
        <>
          <Kbd shortcut={palette} /> shows every command.
        </>
      )}
    </p>
  );
}
