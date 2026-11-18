// The Search options form as data: read from a query, written back as one. Each field holds one
// operator's value; whatever has no field of its own (a second `from:`, `OR`, a group, `-is:starred`)
// stays in "Has the words" as written, so opening and applying the form never loses a term.
import {
  CATEGORY_VALUES,
  HAS_VALUES,
  hasJoiners,
  IN_VALUES,
  IS_VALUES,
  operatorTerm,
  STAR_VALUES,
  terms,
} from "./operators";

export type SizeUnit = "M" | "K" | "";
export type AgeUnit = "d" | "m" | "y";

export interface SearchForm {
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  /** Everything else, as written. */
  words: string;
  /** Words or phrases to leave out, written without their `-`. */
  exclude: string;
  /** One term: `in:inbox`, `label:work`, or "" for all mail. */
  mailbox: string;
  category: string;
  is: string[];
  has: string[];
  star: string;
  filename: string;
  list: string;
  deliveredto: string;
  /** `YYYY-MM-DD`. */
  after: string;
  before: string;
  /** `newer_than:`/`older_than:`: a whole number of days, months or years. */
  newer: string;
  newerUnit: AgeUnit;
  older: string;
  olderUnit: AgeUnit;
  sizeOp: "larger" | "smaller";
  size: string;
  sizeUnit: SizeUnit;
  messageId: string;
  header: string;
}

export const EMPTY_FORM: SearchForm = {
  from: "",
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  words: "",
  exclude: "",
  mailbox: "",
  category: "",
  is: [],
  has: [],
  star: "",
  filename: "",
  list: "",
  deliveredto: "",
  after: "",
  before: "",
  newer: "",
  newerUnit: "d",
  older: "",
  olderUnit: "d",
  sizeOp: "larger",
  size: "",
  sizeUnit: "M",
  messageId: "",
  header: "",
};

/** Text fields named by their operator. */
const TEXT_FIELDS = {
  from: "from",
  to: "to",
  cc: "cc",
  bcc: "bcc",
  subject: "subject",
  filename: "filename",
  list: "list",
  deliveredto: "deliveredto",
  rfc822msgid: "messageId",
  header: "header",
} as const satisfies Record<string, keyof SearchForm>;

const known = (values: readonly { value: string }[], value: string) =>
  values.some((x) => x.value === value);

const pad = (n: string) => n.padStart(2, "0");

/** A Gmail date (`2026/01/31`, `2026-01-31`, `01/31/2026`) as `YYYY-MM-DD`; null otherwise. */
export function dateValue(text: string): string | null {
  const ymd = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(text);
  if (ymd) return `${ymd[1]}-${pad(ymd[2])}-${pad(ymd[3])}`;
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  return mdy ? `${mdy[3]}-${pad(mdy[1])}-${pad(mdy[2])}` : null;
}

export function toForm(query: string): SearchForm {
  const form: SearchForm = { ...EMPTY_FORM, is: [], has: [] };
  const words: string[] = [];
  const exclude: string[] = [];
  const ts = terms(query);
  // `a OR from:b` can't be taken apart: it all stays in Has the words, as written.
  if (hasJoiners(ts)) return { ...form, words: ts.map((t) => t.raw).join(" ") };
  for (const t of ts) {
    if (t.negated && t.key === null && !/^-[({]/.test(t.raw)) {
      exclude.push(t.raw.slice(1));
      continue;
    }
    if (t.negated || t.key === null || !place(form, t.key, t.value, t.written)) words.push(t.raw);
  }
  form.words = words.join(" ");
  form.exclude = exclude.join(" ");
  return form;
}

/** Puts one operator in its field; false when it has none or the field is taken. */
function place(form: SearchForm, key: string, raw: string, written: string): boolean {
  const value = raw.toLowerCase();
  if (key in TEXT_FIELDS) {
    const field = TEXT_FIELDS[key as keyof typeof TEXT_FIELDS];
    if (form[field]) return false;
    // Kept with its quotes: `subject:"plan"` is an exact word, `subject:plan` a prefix.
    form[field] = written;
    return true;
  }
  if (written !== raw) return false;
  switch (key) {
    case "in":
    case "label":
      if (form.mailbox || (key === "in" && !known(IN_VALUES, value))) return false;
      form.mailbox = `${key}:${key === "in" ? value : raw}`;
      return true;
    case "is":
      if (!known(IS_VALUES, value) || form.is.includes(value)) return false;
      form.is.push(value);
      return true;
    case "has":
      if (known(HAS_VALUES, value) && !form.has.includes(value)) {
        form.has.push(value);
        return true;
      }
      if (!known(STAR_VALUES, value) || form.star) return false;
      form.star = value;
      return true;
    case "category":
      if (!known(CATEGORY_VALUES, value) || form.category) return false;
      form.category = value;
      return true;
    case "after":
    case "newer":
    case "before":
    case "older": {
      const field = key === "after" || key === "newer" ? "after" : "before";
      const date = dateValue(raw);
      if (!date || form[field]) return false;
      form[field] = date;
      return true;
    }
    case "newer_than":
    case "older_than": {
      const [field, unit] =
        key === "newer_than"
          ? (["newer", "newerUnit"] as const)
          : (["older", "olderUnit"] as const);
      const age = /^(\d+)([dmy])$/.exec(value);
      if (!age || form[field]) return false;
      form[field] = age[1];
      form[unit] = age[2] as AgeUnit;
      return true;
    }
    case "larger":
    case "smaller":
    case "size": {
      const size = /^(\d+(?:\.\d+)?)([km])?b?$/.exec(value);
      if (!size || form.size) return false;
      form.sizeOp = key === "smaller" ? "smaller" : "larger";
      form.size = size[1];
      form.sizeUnit = (size[2]?.toUpperCase() ?? "") as SizeUnit;
      return true;
    }
    default:
      return false;
  }
}

/** The query the form asks for, empty when it asks for nothing. */
export function fromForm(form: SearchForm): string {
  const out: string[] = [];
  const text = (key: string, value: string) => {
    if (value.trim()) out.push(operatorTerm(key, value));
  };
  text("from", form.from);
  text("to", form.to);
  text("cc", form.cc);
  text("bcc", form.bcc);
  text("subject", form.subject);
  if (form.words.trim()) out.push(form.words.trim());
  for (const t of terms(form.exclude)) out.push(t.negated ? t.raw : `-${t.raw}`);
  if (form.mailbox) out.push(form.mailbox);
  if (form.category) out.push(`category:${form.category}`);
  for (const value of form.is) out.push(`is:${value}`);
  for (const value of form.has) out.push(`has:${value}`);
  if (form.star) out.push(`has:${form.star}`);
  text("filename", form.filename);
  text("list", form.list);
  text("deliveredto", form.deliveredto);
  if (form.after) out.push(`after:${form.after.replace(/-/g, "/")}`);
  if (form.before) out.push(`before:${form.before.replace(/-/g, "/")}`);
  if (/^\d+$/.test(form.newer.trim())) out.push(`newer_than:${form.newer.trim()}${form.newerUnit}`);
  if (/^\d+$/.test(form.older.trim())) out.push(`older_than:${form.older.trim()}${form.olderUnit}`);
  if (/^\d+(\.\d+)?$/.test(form.size.trim()))
    out.push(`${form.sizeOp}:${form.size.trim()}${form.sizeUnit}`);
  text("rfc822msgid", form.messageId);
  text("header", form.header);
  return out.join(" ");
}
