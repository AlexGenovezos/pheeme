// Search options: Gmail's advanced search as a form, one field per operator. It opens on the
// search as typed and writes the search back, so the box and the form never disagree.
import { X } from "lucide-react";
import { type ReactNode, type RefObject, useId, useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/Button";
import { DateField } from "../components/ui/DateField";
import { IconButton } from "../components/ui/IconButton";
import { inPicker } from "../components/ui/Picker";
import { Select, type SelectOption } from "../components/ui/Select";
import { TextInput } from "../components/ui/TextInput";
import { usePopover } from "../components/ui/usePopover";
import { useAccountStore } from "../store/accountStore";
import { useLabelStore } from "../store/labelStore";
import { useUiStore } from "../store/uiStore";
import {
  CATEGORY_VALUES,
  HAS_VALUES,
  IN_VALUES,
  IS_VALUES,
  labelValue,
  STAR_VALUES,
} from "./operators";
import {
  type AgeUnit,
  fromForm,
  invalidFields,
  type SearchForm,
  type SizeUnit,
  toForm,
} from "./searchForm";
import "../components/ui/Surface.css";

/** The form's free-text fields. */
type TextKey =
  | "from"
  | "to"
  | "cc"
  | "bcc"
  | "subject"
  | "words"
  | "exclude"
  | "filename"
  | "list"
  | "deliveredto"
  | "messageId"
  | "header";

const any = (label: string) => [{ value: "", label }];

const SIZE_UNITS: SelectOption<SizeUnit>[] = [
  { value: "M", label: "MB" },
  { value: "K", label: "KB" },
  { value: "", label: "bytes" },
];
const AGE_UNITS: SelectOption<AgeUnit>[] = [
  { value: "d", label: "days" },
  { value: "m", label: "months" },
  { value: "y", label: "years" },
];
const SIZE_OPS: SelectOption<SearchForm["sizeOp"]>[] = [
  { value: "larger", label: "Larger than" },
  { value: "smaller", label: "Smaller than" },
];

/** `value` is one of `options`, or an extra option showing it as written. */
function withValue<T extends string>(options: SelectOption<T>[], value: T): SelectOption<T>[] {
  return options.some((o) => o.value === value) ? options : [...options, { value, label: value }];
}

export function SearchOptions({
  at,
  toggle,
  onClose,
}: {
  at: { x: number; y: number };
  /** The button that opens it: pressing it again closes, rather than closing and reopening. */
  toggle: RefObject<HTMLElement | null>;
  onClose(): void;
}) {
  const accounts = useAccountStore((s) => s.accounts);
  const allLabels = useLabelStore((s) => s.labels);
  const [form, setForm] = useState(() => toForm(useUiStore.getState().searchText));
  const [account, setAccount] = useState(() => {
    const ui = useUiStore.getState();
    return (ui.searchText.trim() ? ui.searchAccountId : ui.mailbox.accountId) ?? "";
  });
  const ref = useRef<HTMLFormElement>(null);
  const id = useId();
  const { pos } = usePopover({
    ref,
    at,
    onClose,
    focusIn: (panel) => panel?.querySelector<HTMLElement>("input, button"),
    ignore: (target) => inPicker(target) || !!toggle.current?.contains(target),
  });

  const set = <K extends keyof SearchForm>(key: K, value: SearchForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const flip = (key: "is" | "has", value: string, on: boolean) =>
    setForm((f) => ({ ...f, [key]: on ? [...f[key], value] : f[key].filter((x) => x !== value) }));

  const labelOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of accounts) {
      if (account && a.id !== account) continue;
      for (const l of allLabels[a.id] ?? []) {
        if (l.type !== "user") continue;
        const value = `label:${labelValue(l.name)}`;
        if (!seen.has(value.toLowerCase())) seen.set(value.toLowerCase(), l.name);
      }
    }
    return [...seen]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([value, name]) => ({ value, label: name, group: "Labels" }));
  }, [accounts, allLabels, account]);

  const invalid = invalidFields(form);
  const search = (e: { preventDefault(): void }) => {
    e.preventDefault();
    if (invalid.length) {
      ref.current?.querySelector<HTMLElement>("[aria-invalid=true]")?.focus();
      return;
    }
    onClose();
    useUiStore.getState().setSearch(fromForm(form), account || null);
  };

  // Label and control are each a cell of the panel's four-column grid: two fields a row, or one wide.
  const field = (label: string, control: ReactNode, wide = false) => (
    <>
      <span className="search-options__label">{label}</span>
      <div
        className={
          wide ? "search-options__control search-options__wide" : "search-options__control"
        }
      >
        {control}
      </div>
    </>
  );
  const text = (label: string, key: TextKey, placeholder = "", wide = false) =>
    field(
      label,
      <TextInput
        aria-label={label}
        value={form[key]}
        placeholder={placeholder}
        onChange={(e) => set(key, e.target.value)}
      />,
      wide,
    );
  const date = (label: string, key: "after" | "before") =>
    field(
      label,
      <>
        <DateField
          aria-label={label}
          value={form[key]}
          placeholder="Any date"
          onChange={(value) => set(key, value)}
        />
        <IconButton
          size="sm"
          label={`Clear ${label.toLowerCase()}`}
          icon={<X />}
          disabled={!form[key]}
          onClick={() => set(key, "")}
        />
      </>,
    );
  const age = (label: string, key: "newer" | "older", unit: "newerUnit" | "olderUnit") =>
    field(
      label,
      <>
        <TextInput
          aria-label={label}
          inputMode="numeric"
          invalid={invalid.includes(key)}
          title={invalid.includes(key) ? "A whole number" : undefined}
          placeholder="Any age"
          value={form[key]}
          onChange={(e) => set(key, e.target.value)}
        />
        <Select
          aria-label={`${label} unit`}
          value={form[unit]}
          options={AGE_UNITS}
          onChange={(value) => set(unit, value)}
        />
      </>,
    );
  const checks = (
    label: string,
    key: "is" | "has",
    values: readonly { value: string; label: string }[],
  ) => (
    <>
      <span className="search-options__label" id={`${id}-${key}`}>
        {label}
      </span>
      <div
        className="search-options__wide search-options__checks"
        role="group"
        aria-labelledby={`${id}-${key}`}
      >
        {values.map((x) => (
          <label key={x.value} className="search-options__check">
            <input
              type="checkbox"
              checked={form[key].includes(x.value)}
              onChange={(e) => flip(key, x.value, e.target.checked)}
            />
            {x.label}
          </label>
        ))}
      </div>
    </>
  );

  return (
    <form
      ref={ref}
      className="search-options popover-surface"
      role="dialog"
      aria-labelledby={`${id}-title`}
      data-owns-keys=""
      style={{ left: pos.x, top: pos.y }}
      onSubmit={search}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <h2 className="search-options__title" id={`${id}-title`}>
        Search options
      </h2>
      <div className="search-options__grid">
        {field(
          "Account",
          <Select
            aria-label="Search accounts"
            value={account}
            options={[
              ...any("All accounts"),
              ...accounts.map((a) => ({ value: a.id, label: a.email })),
            ]}
            onChange={setAccount}
          />,
        )}
        {field(
          "Search in",
          <Select
            aria-label="Search in"
            value={form.mailbox}
            options={withValue(
              [
                ...any("All mail"),
                ...IN_VALUES.map((x) => ({ value: `in:${x.value}`, label: x.label })),
                { value: "label:encryptedmail", label: "Encrypted mail" },
                ...labelOptions,
              ],
              form.mailbox,
            )}
            onChange={(value) => set("mailbox", value)}
          />,
        )}
        {text("From", "from", "Name, address or me")}
        {text("To", "to", "Name, address or me")}
        {text("Cc", "cc")}
        {text("Bcc", "bcc")}
        {text("Subject", "subject", "", true)}
        {text("Has the words", "words", "Words, phrases, OR, AROUND…")}
        {text("Doesn't have", "exclude")}
        {field(
          "Category",
          <Select
            aria-label="Category"
            value={form.category}
            options={[...any("Any category"), ...CATEGORY_VALUES]}
            onChange={(value) => set("category", value)}
          />,
        )}
        {field(
          "Star or icon",
          <Select
            aria-label="Star or icon"
            value={form.star}
            options={[...any("Any"), ...STAR_VALUES]}
            onChange={(value) => set("star", value)}
          />,
        )}
        {date("After", "after")}
        {date("Before", "before")}
        {age("Newer than", "newer", "newerUnit")}
        {age("Older than", "older", "olderUnit")}
        {field(
          "Size",
          <>
            <Select
              className="search-options__fixed"
              aria-label="Size is"
              value={form.sizeOp}
              options={SIZE_OPS}
              onChange={(value) => set("sizeOp", value)}
            />
            <TextInput
              aria-label="Size"
              inputMode="decimal"
              invalid={invalid.includes("size")}
              title={invalid.includes("size") ? "A number" : undefined}
              value={form.size}
              onChange={(e) => set("size", e.target.value)}
            />
            <Select
              aria-label="Size unit"
              value={form.sizeUnit}
              options={SIZE_UNITS}
              onChange={(value) => set("sizeUnit", value)}
            />
          </>,
          true,
        )}
        {text("Attachment name", "filename", "report.pdf or pdf")}
        {text("Mailing list", "list", "list@example.com")}
        {text("Delivered to", "deliveredto")}
        {text("Message ID", "messageId")}
        {text("Header", "header", "X-Mailer:Pheeme", true)}
        {checks("Is", "is", IS_VALUES)}
        {checks("Has", "has", HAS_VALUES)}
      </div>
      <div className="search-options__actions">
        <Button variant="ghost" onClick={() => setForm(toForm(""))}>
          Reset
        </Button>
        <span className="search-options__spacer" />
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary">
          Search
        </Button>
      </div>
    </form>
  );
}
