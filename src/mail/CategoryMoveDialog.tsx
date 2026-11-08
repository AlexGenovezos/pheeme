// The choice a move to an inbox category asks (from Move to… or a drop on the sidebar): just these conversations,
// or also the sender's future mail, which saves a Gmail filter (a sender rule).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Button } from "../components/ui/Button";
import { toast } from "../components/ui/Toast";
import {
  inboxThreadsFrom,
  listSenderRules,
  ruleSenders,
  type SavedRules,
  saveSenderRules,
  toCommandError,
} from "../lib/tauri";
import { ReconnectButton } from "../onboarding/Reconnect";
import { useAccountStore } from "../store/accountStore";
import { moveToCategory } from "./actions";
import { CATEGORIES, parseThreadKey, type ThreadKey } from "./mailboxes";
import "./mail.css";

export interface CategoryMoveSpec {
  accountId: string;
  /** The conversations to move, all from `accountId`. */
  keys: ThreadKey[];
  /** `CATEGORY_*`. */
  category: string;
  /** Viewport coordinates of its top-left corner (clamped to stay on screen). */
  at: { x: number; y: number };
}

interface CategoryMoveState {
  spec: (CategoryMoveSpec & { seq: number }) | null;
  open(spec: CategoryMoveSpec): void;
  close(): void;
}

let seq = 0;

export const useCategoryMoveStore = create<CategoryMoveState>((set) => ({
  spec: null,
  open: (spec) => set({ spec: { ...spec, seq: ++seq } }),
  close: () => set({ spec: null }),
}));

/** Ask how to move `keys` to `category`. */
export function openCategoryMove(spec: CategoryMoveSpec): void {
  if (spec.keys.length > 0) useCategoryMoveStore.getState().open(spec);
}

/** Whether the rule choice can be offered: still checking, yes, or why not. */
type RuleState =
  | { kind: "checking" }
  | { kind: "ready"; senders: string[] }
  | { kind: "no-senders" }
  | { kind: "missing-scope" };

export const categoryName = (category: string) =>
  CATEGORIES.find((c) => c.labelId === category)?.name ?? "Inbox";

/**
 * Moves now, and with `future` saves the sender rules alongside: the move doesn't wait for Gmail, and Undo takes the
 * rules back once they're saved. A rule that can't be saved is said in its own toast; the move stands.
 */
export async function confirmCategoryMove(
  { accountId, keys, category }: CategoryMoveSpec,
  choice: { future: false } | { future: true; senders: string[]; alsoExisting: boolean },
): Promise<void> {
  if (!choice.future) {
    await moveToCategory(accountId, keys, category);
    return;
  }
  const { senders } = choice;
  const rules: Promise<SavedRules | null> = saveSenderRules(accountId, senders, category).catch(
    (e: unknown) => {
      toast({
        title: "Couldn't save the sender rule",
        description: toCommandError(e).message,
        tone: "danger",
      });
      return null;
    },
  );
  const extra = choice.alsoExisting
    ? await inboxThreadsFrom(accountId, senders, category).catch(() => [])
    : [];
  const who = senders.length === 1 ? senders[0] : `these ${senders.length} senders`;
  await moveToCategory(accountId, keys, category, {
    extra,
    rules,
    note: `Future mail from ${who} goes there too`,
  });
}

export function CategoryMoveDialog({ spec, onClose }: { spec: CategoryMoveSpec; onClose(): void }) {
  const { accountId, keys, category, at } = spec;
  const email = useAccountStore((s) => s.accounts.find((a) => a.id === accountId)?.email);
  const [rule, setRule] = useState<RuleState>({ kind: "checking" });
  const [future, setFuture] = useState(false);
  const [alsoExisting, setAlsoExisting] = useState(true);
  const [pos, setPos] = useState(at);
  const ref = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const name = categoryName(category);

  useEffect(() => {
    let live = true;
    const threadIds = keys.map((k) => parseThreadKey(k).threadId);
    void (async () => {
      const senders = await ruleSenders(accountId, threadIds).catch(() => [] as string[]);
      if (senders.length === 0) {
        if (live) setRule({ kind: "no-senders" });
        return;
      }
      // Only to learn whether the account granted filters access: anything else fails later, at the save.
      const missing = await listSenderRules(accountId).then(
        () => false,
        (e: unknown) => toCommandError(e).code === "missing_scope",
      );
      if (live) setRule(missing ? { kind: "missing-scope" } : { kind: "ready", senders });
    })();
    return () => {
      live = false;
    };
  }, [accountId, keys]);

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
    firstRef.current?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      previous?.focus?.();
    };
  }, [onClose]);

  const confirm = () => {
    onClose();
    void confirmCategoryMove(
      spec,
      future && rule.kind === "ready"
        ? { future: true, senders: rule.senders, alsoExisting }
        : { future: false },
    );
  };

  const these = keys.length === 1 ? "this conversation" : `these ${keys.length} conversations`;
  const from =
    rule.kind === "ready"
      ? rule.senders.length === 1
        ? rule.senders[0]
        : `these ${rule.senders.length} senders`
      : keys.length === 1
        ? "this sender"
        : "these senders";
  const canRule = rule.kind === "ready";

  return (
    <div
      ref={ref}
      className="category-move"
      role="dialog"
      aria-label={`Move to ${name}`}
      data-owns-keys=""
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        else if (e.key === "Enter") confirm();
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <h2 className="category-move__title">Move to {name}</h2>
      <div className="category-move__choices" role="radiogroup" aria-label="What to move">
        <label className="category-move__choice">
          <input
            ref={firstRef}
            type="radio"
            name="category-move"
            checked={!future}
            onChange={() => setFuture(false)}
          />
          <span>Just {these}</span>
        </label>
        <label className="category-move__choice" aria-disabled={!canRule || undefined}>
          <input
            type="radio"
            name="category-move"
            checked={future}
            disabled={!canRule}
            onChange={() => setFuture(true)}
          />
          <span>
            This and future mail from <span className="category-move__sender">{from}</span>
          </span>
        </label>
        {canRule && future && (
          <label className="category-move__choice category-move__choice--nested">
            <input
              type="checkbox"
              checked={alsoExisting}
              onChange={(e) => setAlsoExisting(e.target.checked)}
            />
            <span>Also move their other mail in the inbox</span>
          </label>
        )}
      </div>
      {rule.kind === "checking" && (
        <p className="category-move__note" role="status">
          Checking sender rules…
        </p>
      )}
      {rule.kind === "no-senders" && (
        <p className="category-move__note">
          {keys.length === 1 ? "This conversation only has" : "These conversations only have"} mail
          you sent, so there's no sender to make a rule for.
        </p>
      )}
      {rule.kind === "missing-scope" && (
        <div className="category-move__note">
          <p>
            To save sender rules, sign in to {email ?? "this account"} again and allow Pheeme to
            manage your Gmail filters.
          </p>
          <ReconnectButton accountId={accountId} />
        </div>
      )}
      <div className="category-move__actions">
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={confirm}>
          Move
        </Button>
      </div>
    </div>
  );
}

/** Renders the open category move, if any. Mount once. */
export function CategoryMoveHost() {
  const spec = useCategoryMoveStore((s) => s.spec);
  if (!spec) return null;
  return (
    <CategoryMoveDialog
      key={spec.seq}
      spec={spec}
      onClose={useCategoryMoveStore.getState().close}
    />
  );
}
