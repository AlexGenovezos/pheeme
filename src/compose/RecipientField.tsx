import { X } from "lucide-react";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { ContactSuggestion, EmailAddress } from "../lib/tauri";
import { cx } from "../lib/utils";
import {
  addRecipients,
  formatRecipient,
  isValidAddress,
  parseRecipients,
  recipientLabel,
} from "./recipients";

interface RecipientFieldProps {
  label: string;
  value: EmailAddress[];
  onChange(next: EmailAddress[]): void;
  /** Addresses matching what's typed, best first; without it the field suggests nothing. */
  suggest?: (query: string) => Promise<ContactSuggestion[]>;
  /** Extra controls at the end of the row (the Cc / Bcc toggles). */
  trailing?: React.ReactNode;
}

/**
 * Recipients as chips: type or paste addresses, and a comma, Enter, Tab or leaving the field makes them chips.
 * While typing, matching people are suggested below: arrows move, Enter or Tab picks, Escape hides them.
 */
export const RecipientField = forwardRef<HTMLInputElement, RecipientFieldProps>(
  function RecipientField({ label, value, onChange, suggest, trailing }, ref) {
    const [text, setText] = useState("");
    const [suggestions, setSuggestions] = useState<ContactSuggestion[]>([]);
    const [active, setActive] = useState(0);
    // Whether the arrows moved the highlight since the last keystroke.
    const [navigated, setNavigated] = useState(false);
    const [hidden, setHidden] = useState(false);
    const [focused, setFocused] = useState(false);
    const listId = useId();
    const latest = useRef(0);

    const chosen = new Set(value.map((r) => r.address.toLowerCase()));
    const shown = suggestions.filter((s) => !chosen.has(s.address.toLowerCase()));
    const open = focused && !hidden && shown.length > 0 && text.trim() !== "";
    const activeIndex = Math.min(active, shown.length - 1);

    useEffect(() => {
      const query = text.trim();
      const request = ++latest.current;
      if (!suggest || !query || /[,;]/.test(query)) {
        setSuggestions([]);
        return;
      }
      suggest(query).then(
        (found) => request === latest.current && setSuggestions(Array.isArray(found) ? found : []),
        () => request === latest.current && setSuggestions([]),
      );
    }, [text, suggest]);

    const typed = (next: string) => {
      setText(next);
      setActive(0);
      setNavigated(false);
      setHidden(false);
    };

    const commit = (raw: string = text) => {
      const parsed = parseRecipients(raw).map((r) => {
        // A typed address that's a suggestion keeps the person's name.
        const known = r.name
          ? undefined
          : shown.find((s) => s.address.toLowerCase() === r.address.toLowerCase());
        return known ? { name: known.name, address: r.address } : r;
      });
      typed("");
      if (parsed.length > 0) onChange(addRecipients(value, parsed));
    };

    const pick = (s: ContactSuggestion) => {
      typed("");
      onChange(addRecipients(value, [{ name: s.name, address: s.address }]));
    };

    // Enter and Tab take the highlighted suggestion, unless what's typed is already a whole address and
    // the arrows weren't used: then it goes in as typed, so ann@x.com never becomes ann@x.com.au.
    const choice = () =>
      open && (navigated || !isValidAddress(text.trim())) ? shown[activeIndex] : undefined;

    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
      // mod+Enter sends: it never picks a suggestion.
      const modified = e.metaKey || e.ctrlKey || e.altKey;
      if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((activeIndex + step + shown.length) % shown.length);
        setNavigated(true);
      } else if (open && e.key === "Escape") {
        e.preventDefault(); // the panel stays open
        setHidden(true);
      } else if ((e.key === "Enter" || e.key === "Tab") && !modified && choice()) {
        if (e.key === "Enter") e.preventDefault(); // Tab still moves focus on
        pick(choice()!);
      } else if ((e.key === "Enter" || e.key === "," || e.key === ";") && text.trim()) {
        e.preventDefault();
        commit();
      } else if (e.key === "Tab" && text.trim()) {
        commit(); // and let focus move on
      } else if (e.key === "Backspace" && !text && value.length > 0) {
        e.preventDefault();
        const last = value[value.length - 1];
        onChange(value.slice(0, -1));
        typed(formatRecipient(last));
      }
    };

    const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
      const pasted = e.clipboardData.getData("text");
      if (!/[,;\n]/.test(pasted) && !/\s\S+@/.test(pasted)) return;
      e.preventDefault();
      commit(text + pasted);
    };

    const edit = (index: number) => {
      const chip = value[index];
      onChange(value.filter((_, i) => i !== index));
      typed(formatRecipient(chip));
    };

    const optionId = (i: number) => `${listId}-option-${i}`;

    return (
      <div className="compose-field compose-field--recipients">
        <label className="compose-field__label" htmlFor={`${label}-input`}>
          {label}
        </label>
        <ul className="compose-chips" aria-label={`${label} recipients`}>
          {value.map((r, i) => {
            const invalid = !isValidAddress(r.address);
            return (
              <li
                key={`${r.address}-${i}`}
                className={cx("compose-chip", invalid && "compose-chip--invalid")}
                title={invalid ? `“${r.address}” isn't an email address` : formatRecipient(r)}
              >
                <button
                  type="button"
                  className="compose-chip__text"
                  onClick={() => edit(i)}
                  aria-label={`Edit ${recipientLabel(r)}`}
                >
                  {recipientLabel(r)}
                </button>
                <button
                  type="button"
                  className="compose-chip__remove"
                  aria-label={`Remove ${recipientLabel(r)}`}
                  onClick={() => onChange(value.filter((_, j) => j !== i))}
                >
                  <X aria-hidden="true" />
                </button>
              </li>
            );
          })}
          <li className="compose-chips__input">
            <input
              ref={ref}
              id={`${label}-input`}
              className="compose-field__input"
              value={text}
              onChange={(e) => typed(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onFocus={() => setFocused(true)}
              onBlur={() => {
                setFocused(false);
                commit();
              }}
              spellCheck={false}
              autoComplete="off"
              role="combobox"
              aria-label={label}
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={listId}
              aria-activedescendant={open ? optionId(activeIndex) : undefined}
            />
          </li>
        </ul>
        {open && (
          <ul
            id={listId}
            role="listbox"
            aria-label={`Suggested ${label} recipients`}
            className="compose-suggestions"
          >
            {shown.map((s, i) => (
              <li
                key={s.address}
                id={optionId(i)}
                role="option"
                aria-selected={i === activeIndex}
                className="compose-suggestion"
                data-active={i === activeIndex ? "" : undefined}
                // Keep focus in the field, so picking doesn't commit the typed text first.
                onMouseDown={(e) => e.preventDefault()}
                onPointerMove={() => i !== activeIndex && setActive(i)}
                onClick={() => pick(s)}
              >
                {s.name && <span className="compose-suggestion__name">{s.name}</span>}
                <span className="compose-suggestion__address">{s.address}</span>
              </li>
            ))}
          </ul>
        )}
        {trailing}
      </div>
    );
  },
);
