/** Gmail filters for browser preview, with the backend's rules (`src-tauri/src/filters.rs`). */

import type { FilterEntry, FilterSpec } from "../lib/tauri";
import type { FixtureThread } from "./fixtures";
import type { PartialHandlers } from "./handlers";
import type { PreviewLabel } from "./labels";

const CATEGORY_NAMES: Record<string, string> = {
  CATEGORY_PERSONAL: "Primary",
  CATEGORY_SOCIAL: "Social",
  CATEGORY_PROMOTIONS: "Promotions",
  CATEGORY_UPDATES: "Updates",
  CATEGORY_FORUMS: "Forums",
};

const EMPTY: FilterSpec = {
  from: "",
  to: "",
  subject: "",
  query: "",
  negatedQuery: "",
  size: null,
  sizeComparison: null,
  hasAttachment: false,
  excludeChats: false,
  skipInbox: false,
  markRead: false,
  star: false,
  label: null,
  forward: null,
  trash: false,
  neverSpam: false,
  important: null,
  category: null,
};

/** One filter made in Gmail before the preview opened, so the page isn't empty. */
const SEEDED: Record<string, FilterSpec[]> = {
  "acc-personal": [
    { ...EMPTY, from: "receipts@shop.example", label: "Label_1", skipInbox: true },
    { ...EMPTY, subject: "Lisbon", hasAttachment: true, label: "Label_4", star: true },
  ],
};

// A plain word goes bare, anything else grouped (`criteria_query`).
const group = (v: string) =>
  /^[\p{L}\p{N}@._+-]+$/u.test(v) && !v.startsWith("-") && !["OR", "AND", "AROUND"].includes(v)
    ? v
    : `(${v})`;

function matches(spec: FilterSpec): string {
  const parts: string[] = [];
  const add = (op: string, v: string) => v.trim() && parts.push(`${op}${group(v.trim())}`);
  add("from:", spec.from);
  add("to:", spec.to);
  add("subject:", spec.subject);
  add("", spec.query);
  add("-", spec.negatedQuery);
  if (spec.hasAttachment) parts.push("has:attachment");
  if (spec.size !== null && spec.sizeComparison) parts.push(`${spec.sizeComparison}:${spec.size}`);
  return parts.join(" ");
}

function actions(spec: FilterSpec, labelName: (id: string) => string): string[] {
  const out: string[] = [];
  if (spec.label) out.push(`apply label ${labelName(spec.label)}`);
  if (spec.category) out.push(`file it under ${CATEGORY_NAMES[spec.category] ?? spec.category}`);
  if (spec.star) out.push("star it");
  if (spec.trash) out.push("delete it");
  if (spec.important === true) out.push("mark it important");
  if (spec.skipInbox) out.push("skip the inbox (archive it)");
  if (spec.markRead) out.push("mark it as read");
  if (spec.neverSpam) out.push("never send it to spam");
  if (spec.important === false) out.push("never mark it important");
  if (spec.forward) out.push(`forward it to ${spec.forward}`);
  return out;
}

/** The same checks as `FilterSpec::criteria` (and, with `actions`, `to_filter`). */
function check(spec: FilterSpec, actions = true): void {
  const invalid = (message: string) => {
    throw { code: "invalid_input", message };
  };
  const criteria =
    [spec.from, spec.to, spec.subject, spec.query, spec.negatedQuery].some((v) => v.trim()) ||
    spec.size !== null ||
    spec.hasAttachment;
  if (!criteria) invalid("Fill in at least one search option.");
  if (spec.size !== null && !spec.sizeComparison)
    invalid("Choose greater than or less than for the size.");
  if (spec.size !== null && spec.size <= 0) invalid("The size has to be more than zero.");
  if (!actions) return;
  const action =
    spec.skipInbox ||
    spec.markRead ||
    spec.star ||
    spec.trash ||
    spec.neverSpam ||
    spec.important !== null ||
    !!spec.label ||
    !!spec.category ||
    !!spec.forward?.trim();
  if (!action) invalid("Choose at least one thing to do with matching mail.");
}

/**
 * `missingScope`: answer every Gmail-backed call as an account that never granted filters access
 * (`?senderRules=missing`, shared with sender rules). `changeThreads` changes fixture
 * conversations and tells the window, as Also apply filter does.
 */
export function createFilterHandlers(
  threads: FixtureThread[],
  labels: PreviewLabel[],
  missingScope: boolean,
  changeThreads: (
    args: { accountId: string; threadIds: string[] },
    change: (t: FixtureThread) => void,
  ) => void,
) {
  const filters = new Map<string, { id: string; spec: FilterSpec }[]>();
  let next = 0;
  const of = (accountId: string) => {
    if (!filters.has(accountId))
      filters.set(
        accountId,
        (SEEDED[accountId] ?? []).map((spec) => ({ id: `filter_${++next}`, spec })),
      );
    return filters.get(accountId)!;
  };
  const gmail = () => {
    if (missingScope)
      throw {
        code: "missing_scope",
        message: "Gmail API error 403 (insufficientPermissions): Insufficient Permission",
      };
  };
  const entry = (accountId: string, id: string, spec: FilterSpec): FilterEntry => ({
    id,
    matches: matches(spec),
    actions: actions(
      spec,
      (label) => labels.find((l) => l.id === label && l.accountId === accountId)?.name ?? label,
    ),
    spec,
  });
  const hits = (accountId: string, spec: FilterSpec) => {
    const has = (text: string, v: string) =>
      v
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .every((w) => text.toLowerCase().includes(w));
    return threads.filter(
      (t) =>
        t.accountId === accountId &&
        !t.labelIds.includes("TRASH") &&
        (!spec.from.trim() || t.messages.some((m) => has(m.fromAddress, spec.from))) &&
        (!spec.subject.trim() || has(t.subject, spec.subject)) &&
        (!spec.query.trim() ||
          has(`${t.subject} ${t.messages.map((m) => m.bodyText ?? "").join(" ")}`, spec.query)),
    );
  };
  const apply = (accountId: string, spec: FilterSpec) => {
    const add = [
      spec.label,
      spec.category,
      spec.star && "STARRED",
      spec.important === true && "IMPORTANT",
    ];
    const remove = [spec.skipInbox && "INBOX", spec.important === false && "IMPORTANT"];
    changeThreads({ accountId, threadIds: hits(accountId, spec).map((t) => t.id) }, (t) => {
      for (const l of remove) if (l) t.labelIds = t.labelIds.filter((x) => x !== l);
      for (const l of add) if (l && !t.labelIds.includes(l)) t.labelIds.push(l);
      if (spec.markRead) t.messages.forEach((m) => (m.unread = false));
      if (spec.trash) t.labelIds = [...t.labelIds.filter((x) => x !== "INBOX"), "TRASH"];
    });
  };
  const same = (a: FilterSpec, b: FilterSpec) => JSON.stringify(a) === JSON.stringify(b);
  return {
    list_filters: (args): FilterEntry[] => {
      gmail();
      return of(args.accountId).map((f) => entry(args.accountId, f.id, f.spec));
    },
    create_filter: (args): FilterEntry => {
      check(args.spec);
      gmail();
      const list = of(args.accountId);
      if (list.some((f) => same(f.spec, args.spec)))
        throw {
          code: "invalid_input",
          message: "You already have a filter that does exactly this.",
        };
      const made = { id: `filter_${++next}`, spec: { ...args.spec } };
      list.push(made);
      if (args.applyToExisting) apply(args.accountId, args.spec);
      return entry(args.accountId, made.id, made.spec);
    },
    replace_filter: (args): FilterEntry => {
      check(args.spec);
      gmail();
      const list = of(args.accountId);
      const at = list.findIndex((f) => f.id === args.filterId);
      if (at === -1)
        throw {
          code: "invalid_input",
          message:
            "That filter isn't in Gmail any more. Reopen Settings › Filters to see what's there.",
        };
      const made = same(list[at].spec, args.spec)
        ? list[at]
        : { id: `filter_${++next}`, spec: { ...args.spec } };
      list.splice(at, 1, made);
      if (args.applyToExisting) apply(args.accountId, args.spec);
      return entry(args.accountId, made.id, made.spec);
    },
    delete_filter: (args) => {
      gmail();
      const list = of(args.accountId);
      const at = list.findIndex((f) => f.id === args.filterId);
      if (at === -1)
        throw {
          code: "invalid_input",
          message: `There's no filter ${args.filterId} on this account.`,
        };
      list.splice(at, 1);
    },
    filter_matches: (args): number | null => {
      check(args.spec, false);
      // Like the local search: `-word` is Gmail-only syntax, so only Gmail could count it.
      if (args.spec.negatedQuery.trim()) return null;
      return hits(args.accountId, args.spec).length;
    },
    forwarding_addresses: (args): string[] => {
      gmail();
      return args.accountId === "acc-personal" ? ["avery.archive@example.net"] : [];
    },
  } satisfies PartialHandlers;
}
