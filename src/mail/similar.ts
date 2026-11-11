// Find similar: the search for mail like one conversation, from its sender or with its subject.
import type { MessageDetail, ThreadSummary } from "../lib/tauri";

export type SimilarBy = "sender" | "subject";

/** The subject without the `Re:` / `Fwd:` prefixes replies and forwards add. */
export function baseSubject(subject: string): string {
  let s = subject.trim();
  for (;;) {
    const next = s.replace(/^(re|fwd?|aw|wg)\s*(\[\d+\])?\s*:\s*/i, "").trim();
    if (next === s) return s;
    s = next;
  }
}

/**
 * Who the conversation is from, for "Same sender": its latest message from someone else (your own replies would find
 * all of your sent mail), else the row's sender unless that is you. `own` is the account's address.
 */
export function similarSender(
  row: Pick<ThreadSummary, "fromAddress"> | undefined,
  messages: Pick<MessageDetail, "fromAddress" | "labelIds">[] | undefined,
  own: string | undefined,
): string | null {
  const mine = (address: string | null | undefined) =>
    !!address && !!own && address.trim().toLowerCase() === own.trim().toLowerCase();
  const theirs = messages?.filter(
    (m) => m.fromAddress?.trim() && !m.labelIds.includes("DRAFT") && !mine(m.fromAddress),
  );
  const latest = theirs?.[theirs.length - 1]?.fromAddress?.trim();
  if (latest) return latest;
  const fromRow = row?.fromAddress?.trim();
  return fromRow && !mine(fromRow) ? fromRow : null;
}

/** The search for mail like this: `from:` the sender, or the subject as a phrase. Null when there's nothing to go on. */
export function similarQuery(
  by: SimilarBy,
  { sender, subject }: { sender: string | null; subject: string | null },
): string | null {
  if (by === "sender") return sender ? `from:${sender}` : null;
  // Gmail has no way to escape a quote inside a phrase, so quotes become spaces.
  const phrase = baseSubject(subject ?? "")
    .replace(/"/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return phrase ? `subject:"${phrase}"` : null;
}
