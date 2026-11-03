import type { EmailAddress } from "../lib/tauri";

const ADDRESS = /^[^\s@<>()",;:[\]]+@[^\s@<>()",;:[\]]+\.[^\s@<>()",;:[\]]+$/;

export const isValidAddress = (address: string) => ADDRESS.test(address.trim());

/** Split pasted or typed text on commas, semicolons and line breaks outside quotes and `<…>`. */
function split(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (const ch of text) {
    if (ch === '"' && !angled) quoted = !quoted;
    else if (ch === "<" && !quoted) angled = true;
    else if (ch === ">" && !quoted) angled = false;
    if (!quoted && !angled && (ch === "," || ch === ";" || ch === "\n" || ch === "\r")) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** One recipient from `Name <a@b.c>`, `"Name" <a@b.c>`, `<a@b.c>` or `a@b.c`. */
export function parseRecipient(text: string): EmailAddress {
  const t = text.trim();
  const angled = /^(.*?)<([^<>]*)>\s*$/.exec(t);
  if (angled) {
    const name = angled[1]
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .trim();
    return { name: name || null, address: angled[2].trim() };
  }
  return { name: null, address: t.replace(/^mailto:/i, "") };
}

/** Every recipient in `text`. A list of bare addresses separated by spaces counts too. */
export function parseRecipients(text: string): EmailAddress[] {
  return split(text).flatMap((part) => {
    const words = part.split(/\s+/);
    if (words.length > 1 && words.every((w) => isValidAddress(w)))
      return words.map((address) => ({ name: null, address }));
    return [parseRecipient(part)];
  });
}

/** The name when there is one, else the address. */
export const recipientLabel = (r: EmailAddress) => r.name?.trim() || r.address;

/** `Name <address>` for editing a chip as text. */
export const formatRecipient = (r: EmailAddress) =>
  r.name?.trim() ? `${r.name.trim()} <${r.address}>` : r.address;

/** `list` plus `more`, without repeating an address already there (case-insensitive). */
export function addRecipients(list: EmailAddress[], more: EmailAddress[]): EmailAddress[] {
  const seen = new Set(list.map((r) => r.address.toLowerCase()));
  const out = [...list];
  for (const r of more) {
    const key = r.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
