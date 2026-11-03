import { X } from "lucide-react";
import { type ClipboardEvent, type KeyboardEvent, forwardRef, useState } from "react";
import type { EmailAddress } from "../lib/tauri";
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
  /** Extra controls at the end of the row (the Cc / Bcc toggles). */
  trailing?: React.ReactNode;
}

/** Recipients as chips: type or paste addresses, and a comma, Enter, Tab or leaving the field makes them chips. */
export const RecipientField = forwardRef<HTMLInputElement, RecipientFieldProps>(
  function RecipientField({ label, value, onChange, trailing }, ref) {
    const [text, setText] = useState("");

    const commit = (raw: string = text) => {
      const parsed = parseRecipients(raw);
      setText("");
      if (parsed.length > 0) onChange(addRecipients(value, parsed));
    };

    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
      if ((e.key === "Enter" || e.key === "," || e.key === ";") && text.trim()) {
        e.preventDefault();
        commit();
      } else if (e.key === "Tab" && text.trim()) {
        commit(); // and let focus move on
      } else if (e.key === "Backspace" && !text && value.length > 0) {
        e.preventDefault();
        const last = value[value.length - 1];
        onChange(value.slice(0, -1));
        setText(formatRecipient(last));
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
      setText(formatRecipient(chip));
    };

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
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onBlur={() => commit()}
              spellCheck={false}
              autoComplete="off"
              aria-label={label}
            />
          </li>
        </ul>
        {trailing}
      </div>
    );
  },
);
