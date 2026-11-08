/** Sender rules for browser preview, with the backend's reuse/replace rules (`src-tauri/src/sender_rules.rs`). */

import type { InboxThread, SavedRules, SenderRule } from "../lib/tauri";
import type { FixtureThread } from "./fixtures";

type Args = Record<string, unknown> | undefined;

const CATEGORIES = [
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
];

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
const clean = (senders: unknown) => [
  ...new Set(strings(senders).map((s) => s.trim().toLowerCase())),
];

/**
 * `missingScope`: answer every Gmail-backed call as an account that never granted filters access
 * (`?senderRules=missing`).
 */
export function createSenderRuleHandlers(
  threads: FixtureThread[],
  emailOf: (accountId: string) => string | undefined,
  missingScope: boolean,
) {
  const rules = new Map<string, SenderRule[]>();
  let next = 0;
  const of = (accountId: unknown) => {
    const id = String(accountId);
    if (!rules.has(id)) rules.set(id, []);
    return rules.get(id)!;
  };
  const gmail = () => {
    if (missingScope)
      throw {
        code: "missing_scope",
        message: "Gmail API error 403 (insufficientPermissions): Insufficient Permission",
      };
  };
  const category = (value: unknown) => {
    const c = String(value);
    if (!CATEGORIES.includes(c))
      throw { code: "invalid_input", message: `${c} isn't an inbox category.` };
    return c;
  };
  return {
    list_sender_rules: (args: Args): SenderRule[] => {
      gmail();
      return [...of(args?.accountId)];
    },
    rule_senders: (args: Args): string[] => {
      const own = emailOf(String(args?.accountId))?.toLowerCase();
      const out: string[] = [];
      for (const id of strings(args?.threadIds)) {
        const t = threads.find((f) => f.id === id && f.accountId === args?.accountId);
        const latest = t?.messages
          .filter((m) => m.fromAddress.toLowerCase() !== own)
          .sort((a, b) => b.date - a.date)[0];
        const sender = latest?.fromAddress.toLowerCase();
        if (sender && !out.includes(sender)) out.push(sender);
      }
      return out;
    },
    save_sender_rules: (args: Args): SavedRules => {
      const target = category(args?.category);
      gmail();
      const list = of(args?.accountId);
      const saved: SavedRules = { created: [], replaced: [] };
      for (const sender of clean(args?.senders)) {
        const theirs = list.filter((r) => r.sender === sender);
        if (!theirs.some((r) => r.category === target)) {
          const id = `filter_${++next}`;
          list.push({ id, sender, category: target });
          saved.created.push(id);
        }
        for (const old of theirs.filter((r) => r.category !== target)) {
          list.splice(list.indexOf(old), 1);
          saved.replaced.push(old);
        }
      }
      return saved;
    },
    undo_sender_rules: (args: Args) => {
      gmail();
      const list = of(args?.accountId);
      const saved = args?.saved as SavedRules;
      for (const id of saved.created) {
        const at = list.findIndex((r) => r.id === id);
        if (at !== -1) list.splice(at, 1);
      }
      for (const rule of saved.replaced) list.push({ ...rule, id: `filter_${++next}` });
    },
    delete_sender_rule: (args: Args) => {
      gmail();
      const list = of(args?.accountId);
      const at = list.findIndex((r) => r.id === args?.ruleId);
      if (at !== -1) list.splice(at, 1);
    },
    inbox_threads_from: (args: Args): InboxThread[] => {
      const target = category(args?.category);
      const senders = clean(args?.senders);
      return threads
        .filter(
          (t) =>
            t.accountId === args?.accountId &&
            t.labelIds.includes("INBOX") &&
            t.messages.some((m) => senders.includes(m.fromAddress.toLowerCase())),
        )
        .map((t) => ({
          threadId: t.id,
          categories: t.labelIds.filter((l) => CATEGORIES.includes(l)).sort(),
        }))
        .filter(({ categories }) =>
          target === "CATEGORY_PERSONAL"
            ? categories.some((c) => c !== target)
            : !categories.includes(target),
        );
    },
  };
}
