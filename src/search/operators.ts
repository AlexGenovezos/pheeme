// Gmail's search operators (support.google.com/mail/answer/7190), and the query as terms: what the
// Search options form reads and writes, and what the search box suggests while a word is typed.
// Every operator here goes to Gmail as written; the cache answers the ones it can (src-tauri/src/search.rs).

export interface OperatorValue {
  value: string;
  label: string;
}

export interface Operator {
  key: string;
  /** What it finds, as the suggestion's note. */
  hint: string;
  /** The values Gmail accepts, when it accepts a fixed set. */
  values?: readonly OperatorValue[];
}

const v = (value: string, label: string): OperatorValue => ({ value, label });

/** `in:` mailboxes, in the order Gmail's own Search menu lists them. */
export const IN_VALUES = [
  v("inbox", "Inbox"),
  v("archive", "Archive"),
  v("starred", "Starred"),
  v("snoozed", "Snoozed"),
  v("important", "Important"),
  v("sent", "Sent"),
  v("drafts", "Drafts"),
  v("scheduled", "Scheduled"),
  v("chats", "Chats"),
  v("spam", "Spam"),
  v("trash", "Trash"),
  v("anywhere", "Mail, Spam and Trash"),
] as const;

export const IS_VALUES = [
  v("unread", "Unread"),
  v("read", "Read"),
  v("starred", "Starred"),
  v("important", "Important"),
  v("muted", "Muted"),
] as const;

/** `has:` values that say what a message holds (the stars are `STAR_VALUES`). */
export const HAS_VALUES = [
  v("attachment", "Attachment"),
  v("drive", "Google Drive file"),
  v("document", "Google Doc"),
  v("spreadsheet", "Google Sheet"),
  v("presentation", "Google Slides"),
  v("youtube", "YouTube video"),
  v("userlabels", "Any of your labels"),
  v("nouserlabels", "None of your labels"),
] as const;

export const STAR_VALUES = [
  v("yellow-star", "Yellow star"),
  v("orange-star", "Orange star"),
  v("red-star", "Red star"),
  v("purple-star", "Purple star"),
  v("blue-star", "Blue star"),
  v("green-star", "Green star"),
  v("red-bang", "Red bang"),
  v("orange-guillemet", "Orange guillemet"),
  v("yellow-bang", "Yellow bang"),
  v("green-check", "Green check"),
  v("blue-info", "Blue info"),
  v("purple-question", "Purple question"),
] as const;

export const CATEGORY_VALUES = [
  v("primary", "Primary"),
  v("social", "Social"),
  v("promotions", "Promotions"),
  v("updates", "Updates"),
  v("forums", "Forums"),
  v("reservations", "Reservations"),
  v("purchases", "Purchases"),
] as const;

/** `newer_than:`/`older_than:` periods. */
export const AGE_VALUES = [
  v("1d", "1 day"),
  v("3d", "3 days"),
  v("7d", "1 week"),
  v("14d", "2 weeks"),
  v("1m", "1 month"),
  v("2m", "2 months"),
  v("6m", "6 months"),
  v("1y", "1 year"),
] as const;

const ME = [v("me", "You")];

export const OPERATORS: readonly Operator[] = [
  { key: "from", hint: "Sender", values: ME },
  { key: "to", hint: "Recipient", values: ME },
  { key: "cc", hint: "Copied", values: ME },
  { key: "bcc", hint: "Blind copied", values: ME },
  { key: "subject", hint: "Words in the subject" },
  { key: "label", hint: "Has a label" },
  { key: "in", hint: "In a mailbox", values: IN_VALUES },
  { key: "is", hint: "Unread, starred, muted…", values: IS_VALUES },
  { key: "has", hint: "Attachment, Drive file, star…", values: [...HAS_VALUES, ...STAR_VALUES] },
  { key: "category", hint: "Inbox category", values: CATEGORY_VALUES },
  { key: "filename", hint: "Attachment name or type" },
  { key: "list", hint: "From a mailing list" },
  { key: "deliveredto", hint: "Delivered to an address" },
  { key: "after", hint: "Sent after a date (2026/01/31)" },
  { key: "before", hint: "Sent before a date (2026/01/31)" },
  { key: "newer_than", hint: "Newer than a period (3d, 2m, 1y)", values: AGE_VALUES },
  { key: "older_than", hint: "Older than a period (3d, 2m, 1y)", values: AGE_VALUES },
  { key: "larger", hint: "Larger than a size (10M)" },
  { key: "smaller", hint: "Smaller than a size (500K)" },
  { key: "size", hint: "Larger than a size in bytes" },
  { key: "rfc822msgid", hint: "A message's Message-ID" },
  { key: "header", hint: "A header or header value" },
];

/** Gmail also reads `older:`/`newer:` as `before:`/`after:`; they're understood, not suggested. */
const KEYS = new Set([...OPERATORS.map((o) => o.key), "older", "newer"]);

/** One term of a query: `word`, `"a phrase"`, `key:value`, `-term`, or a group in `()`/`{}`. */
export interface Term {
  /** As written, including any `-`. */
  raw: string;
  negated: boolean;
  /** A known operator's key, lower case; null for words, phrases and groups. */
  key: string | null;
  /** The operator's value without its quotes, or the word or phrase. */
  value: string;
}

/** Splits a query into terms, keeping quoted phrases and bracketed groups whole. */
export function terms(query: string): Term[] {
  const out: Term[] = [];
  let i = 0;
  while (i < query.length) {
    if (/\s/.test(query[i])) {
      i++;
      continue;
    }
    const start = i;
    let quoted = false;
    let depth = 0;
    for (; i < query.length; i++) {
      const c = query[i];
      if (c === '"') quoted = !quoted;
      else if (quoted) continue;
      else if (c === "(" || c === "{") depth++;
      else if ((c === ")" || c === "}") && depth > 0) depth--;
      else if (/\s/.test(c) && depth === 0) break;
    }
    out.push(term(query.slice(start, i)));
  }
  return out;
}

function term(raw: string): Term {
  const negated = raw.length > 1 && raw.startsWith("-");
  const body = negated ? raw.slice(1) : raw;
  const colon = body.indexOf(":");
  const key = colon > 0 ? body.slice(0, colon).toLowerCase() : "";
  const rest = colon > 0 ? body.slice(colon + 1) : "";
  if (KEYS.has(key) && rest) return { raw, negated, key, value: unquote(rest) };
  return { raw, negated, key: null, value: unquote(body) };
}

const unquote = (s: string) =>
  s.length > 1 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;

/** `key:value`, quoting a value with spaces so it stays one term. */
export function operatorTerm(key: string, value: string): string {
  const text = value.trim();
  return /\s/.test(text) && !/^["({]/.test(text) ? `${key}:"${text}"` : `${key}:${text}`;
}

/** Whether `query` has the term (`is:unread`), not negated. */
export function hasTerm(query: string, key: string, value: string): boolean {
  return terms(query).some(
    (t) => !t.negated && t.key === key && t.value.toLowerCase() === value.toLowerCase(),
  );
}

/** `query` with the term added at the end, or every copy of it taken out. */
export function toggleTerm(query: string, key: string, value: string, on: boolean): string {
  const kept = terms(query).filter(
    (t) => t.negated || t.key !== key || t.value.toLowerCase() !== value.toLowerCase(),
  );
  return [...kept.map((t) => t.raw), ...(on ? [operatorTerm(key, value)] : [])].join(" ");
}

/** How a label is written after `label:`: Gmail reads spaces and slashes as dashes. */
export const labelValue = (name: string) => name.trim().replace(/[\s/]+/g, "-");

export interface Suggestion {
  /** What replaces the word being typed. */
  insert: string;
  /** Shown in bold: the operator or its value. */
  label: string;
  hint: string;
}

/**
 * Operators (or an operator's values) for the word that ends at `caret`, and where that word starts.
 * A word needs two letters before operators are offered, so ordinary typing stays quiet.
 */
export function suggest(
  query: string,
  caret: number,
  labels: readonly string[],
): { start: number; items: Suggestion[] } {
  const before = query.slice(0, caret);
  const start = before.search(/\S*$/) + (before.match(/\S*$/)?.[0].startsWith("-") ? 1 : 0);
  const word = query.slice(start, caret);
  const none = { start, items: [] };
  // Only at the end of a word: editing the middle of one shouldn't pop suggestions.
  if (!word || /^\S/.test(query.slice(caret))) return none;
  const colon = word.indexOf(":");
  if (colon < 0) {
    if (word.length < 2) return none;
    const lower = word.toLowerCase();
    return {
      start,
      items: OPERATORS.filter((o) => o.key.startsWith(lower)).map((o) => ({
        insert: `${o.key}:`,
        label: `${o.key}:`,
        hint: o.hint,
      })),
    };
  }
  const key = word.slice(0, colon).toLowerCase();
  const typed = word.slice(colon + 1).toLowerCase();
  const values =
    key === "label"
      ? labels.map((name) => v(labelValue(name), name))
      : (OPERATORS.find((o) => o.key === key)?.values ?? []);
  return {
    start,
    items: values
      .filter((x) => x.value.toLowerCase().startsWith(typed) && x.value.toLowerCase() !== typed)
      .slice(0, 12)
      .map((x) => ({ insert: `${key}:${x.value} `, label: `${key}:${x.value}`, hint: x.label })),
  };
}
