// The filter editor's form: Gmail web's search options and actions as the fields show them (size
// as a number and a unit, the label picker's "New label…"), and the `FilterSpec` they become.
import type { FilterSpec } from "../lib/tauri";

export const SIZE_UNITS = ["MB", "KB", "bytes"] as const;
export type SizeUnit = (typeof SIZE_UNITS)[number];
const UNIT_BYTES: Record<SizeUnit, number> = { MB: 1024 * 1024, KB: 1024, bytes: 1 };

/** The label picker's choice that makes a new label from the name field. */
export const NEW_LABEL = "__new__";

export const CATEGORY_CHOICES = [
  { value: "CATEGORY_PERSONAL", label: "Primary" },
  { value: "CATEGORY_SOCIAL", label: "Social" },
  { value: "CATEGORY_PROMOTIONS", label: "Promotions" },
  { value: "CATEGORY_UPDATES", label: "Updates" },
  { value: "CATEGORY_FORUMS", label: "Forums" },
] as const;

/** A spec that matches and does nothing yet. */
export const EMPTY_SPEC: FilterSpec = {
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

export interface FilterForm {
  from: string;
  to: string;
  subject: string;
  query: string;
  negatedQuery: string;
  sizeComparison: "larger" | "smaller";
  /** As typed; empty means no size criterion. */
  size: string;
  sizeUnit: SizeUnit;
  hasAttachment: boolean;
  excludeChats: boolean;
  skipInbox: boolean;
  markRead: boolean;
  star: boolean;
  applyLabel: boolean;
  /** A user label's id, or `NEW_LABEL`. */
  label: string;
  newLabel: string;
  forwardOn: boolean;
  forward: string;
  trash: boolean;
  neverSpam: boolean;
  alwaysImportant: boolean;
  neverImportant: boolean;
  categorize: boolean;
  category: string;
}

/** A size in bytes as the biggest unit it's a whole number of, as Gmail web shows it. */
export function sizeParts(bytes: number): { size: string; unit: SizeUnit } {
  const unit = SIZE_UNITS.find((u) => bytes % UNIT_BYTES[u] === 0) ?? "bytes";
  return { size: String(bytes / UNIT_BYTES[unit]), unit };
}

/** The form showing `partial` (a filter being edited, or Filter messages like these' sender). */
export function formOf(partial: Partial<FilterSpec>): FilterForm {
  const spec = { ...EMPTY_SPEC, ...partial };
  const size = spec.size === null ? { size: "", unit: "MB" as SizeUnit } : sizeParts(spec.size);
  return {
    from: spec.from,
    to: spec.to,
    subject: spec.subject,
    query: spec.query,
    negatedQuery: spec.negatedQuery,
    sizeComparison: spec.sizeComparison ?? "larger",
    size: size.size,
    sizeUnit: size.unit,
    hasAttachment: spec.hasAttachment,
    excludeChats: spec.excludeChats,
    skipInbox: spec.skipInbox,
    markRead: spec.markRead,
    star: spec.star,
    applyLabel: spec.label !== null,
    label: spec.label ?? "",
    newLabel: "",
    forwardOn: spec.forward !== null,
    forward: spec.forward ?? "",
    trash: spec.trash,
    neverSpam: spec.neverSpam,
    alwaysImportant: spec.important === true,
    neverImportant: spec.important === false,
    categorize: spec.category !== null,
    category: spec.category ?? "CATEGORY_UPDATES",
  };
}

/** The size in bytes, null when the field is empty, NaN when it isn't a positive number. */
export function sizeBytes(form: Pick<FilterForm, "size" | "sizeUnit">): number | null {
  const text = form.size.trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? Math.round(n * UNIT_BYTES[form.sizeUnit]) : NaN;
}

/** Whether any search option is filled in (Gmail web's Create filter needs one). */
export function hasCriteria(form: FilterForm): boolean {
  return (
    [form.from, form.to, form.subject, form.query, form.negatedQuery, form.size].some((v) =>
      v.trim(),
    ) || form.hasAttachment
  );
}

/** Whether any action is chosen. */
export function hasAction(form: FilterForm): boolean {
  return (
    form.skipInbox ||
    form.markRead ||
    form.star ||
    form.applyLabel ||
    form.forwardOn ||
    form.trash ||
    form.neverSpam ||
    form.alwaysImportant ||
    form.neverImportant ||
    form.categorize
  );
}

/** The spec's search options alone (for counting matches), or null when there are none yet. */
export function criteriaOf(form: FilterForm): FilterSpec | null {
  const size = sizeBytes(form);
  if (!hasCriteria(form) || Number.isNaN(size)) return null;
  return {
    ...EMPTY_SPEC,
    from: form.from.trim(),
    to: form.to.trim(),
    subject: form.subject.trim(),
    query: form.query.trim(),
    negatedQuery: form.negatedQuery.trim(),
    size,
    sizeComparison: size === null ? null : form.sizeComparison,
    hasAttachment: form.hasAttachment,
    excludeChats: form.excludeChats,
  };
}

/**
 * The spec the form saves, with `labelId` for the label it applies (the new label's, once made),
 * or why it can't be saved yet.
 */
export function specOf(
  form: FilterForm,
  labelId: string | null,
): { spec: FilterSpec } | { problem: string } {
  if (!hasCriteria(form)) return { problem: "Fill in at least one search option." };
  const criteria = criteriaOf(form);
  if (!criteria) return { problem: "Type the size as a number greater than zero." };
  if (!hasAction(form)) return { problem: "Choose at least one thing to do with matching mail." };
  if (form.applyLabel && !labelId)
    return {
      problem: form.label === NEW_LABEL ? "Name the new label." : "Choose a label to apply.",
    };
  if (form.forwardOn && !form.forward) return { problem: "Choose an address to forward to." };
  return {
    spec: {
      ...criteria,
      skipInbox: form.skipInbox,
      markRead: form.markRead,
      star: form.star,
      label: form.applyLabel ? labelId : null,
      forward: form.forwardOn ? form.forward : null,
      trash: form.trash,
      neverSpam: form.neverSpam,
      important: form.alwaysImportant ? true : form.neverImportant ? false : null,
      category: form.categorize ? form.category : null,
    },
  };
}

/** What Also apply filter does to mail already there; false when nothing (forward only, say). */
export function changesExisting(form: FilterForm): boolean {
  return (
    form.skipInbox ||
    form.markRead ||
    form.star ||
    form.applyLabel ||
    form.trash ||
    form.alwaysImportant ||
    form.neverImportant ||
    form.categorize
  );
}

/** "Also apply filter to 3 matching conversations." (the count once known). */
export function applyExistingLabel(count: number | null | undefined): string {
  if (typeof count !== "number") return "Also apply filter to matching conversations.";
  return `Also apply filter to ${count} matching conversation${count === 1 ? "" : "s"}.`;
}

/** A filter's phrase list as one sentence: "Skip the inbox (archive it), star it". */
export function sentence(actions: string[]): string {
  const text = actions.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
