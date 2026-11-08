import type { MessageDetail, ThreadSummary } from "../lib/tauri";

/**
 * Finds the one-time code in a sign-in or verification email ("Your verification code is 779693"), so the
 * conversation can show it with a copy button and the list can offer it without opening the email.
 *
 * Wrong is worse than missed: an order number or phone number offered as a "code" is the failure to avoid.
 * So the email has to say it's a code email, and the code has to sit close to the word "code". Codes with
 * letters (`K7Q2XP`, `ABC-D3F`) need the strongest wording, because booking references and promo codes
 * look just like them; "confirmation code" and "your code is" only vouch for digits.
 */

/** Wording that makes an email a sign-in or verification code email. */
const STRONG =
  /\b(?:verification|verify|security|log[- ]?in|sign[- ]?in|one[- ]time|single[- ]use|authentication|2fa|two[- ]factor|2-step|two[- ]step|mfa)\s+(?:code|passcode|pin)\b|\b(?:passcode|otp)\b/gi;
/** Wording that's enough for an all-digit code. */
const WEAK =
  /\b(?:confirmation|temporary|access)\s+(?:code|pin)\b|\b(?:is|as) your (?:[\w-]+ ){0,3}(?:code|passcode|pin)\b|\byour code is\b|\benter (?:this|the following) code\b/gi;
/** How far (in characters) a code may sit from that wording. */
const NEAR = 80;
/** What comes just before a number that only identifies something: "the phone ending in 1234". */
const IDENTIFIES = /\b(?:ending|ends) (?:in|with) $|\blast (?:\d|four|4) digits(?: of)?:? $/i;

/**
 * A code standing on its own: 4–8 digits, digits grouped 3+3 or 4+4, or 5–8 capitals and digits (optionally
 * one dash). Not part of a longer number, a price, an order number or a word.
 */
const CANDIDATE =
  /(?<![\w#$€£+@/.-]|\d[ -])(\d{3}[ -]\d{3}|\d{4}[ -]\d{4}|[A-Z0-9]{2,4}-[A-Z0-9]{2,4}|[A-Z0-9]{4,8})(?![\w%/@]|[ -]\d|[.,-][A-Za-z0-9])/g;

interface Candidate {
  code: string;
  letters: boolean;
  start: number;
  end: number;
}

function candidates(text: string): Candidate[] {
  const found: Candidate[] = [];
  for (const m of text.matchAll(CANDIDATE)) {
    const raw = m[1];
    const hasLetter = /[A-Z]/.test(raw);
    const digitsOnly = raw.replace(/[ -]/g, "");
    if (!/\d/.test(raw)) continue;
    if (IDENTIFIES.test(text.slice(Math.max(0, m.index - 24), m.index))) continue;
    if (hasLetter) {
      if (raw.replace("-", "").length < 5) continue;
    } else {
      if (!/^\d{4,8}$/.test(digitsOnly)) continue;
      // A year ("expires in 2026") reads as a date, not a code.
      if (/^(?:19|20)\d\d$/.test(digitsOnly)) continue;
    }
    const start = m.index;
    found.push({
      code: hasLetter ? raw : digitsOnly,
      letters: hasLetter,
      start,
      end: start + raw.length,
    });
  }
  return found;
}

/**
 * The one-time code in `text`, or null when the text isn't a code email or no code sits near the wording.
 * Distance is measured to the wording itself, not to any "code": in "Your verification code is 123456.
 * Discount code SAVE20" the promo code is next to a "code" but not to the verification wording.
 */
export function findCode(text: string): string | null {
  const flat = text.replace(/\s+/g, " ");
  const anchors = [
    ...[...flat.matchAll(STRONG)].map((m) => ({ m, strong: true })),
    ...[...flat.matchAll(WEAK)].map((m) => ({ m, strong: false })),
  ].map(({ m, strong }) => ({ start: m.index, end: m.index + m[0].length, strong }));
  if (!anchors.length) return null;
  let best: { code: string; distance: number } | null = null;
  for (const c of candidates(flat)) {
    for (const a of anchors) {
      if (c.letters && !a.strong) continue;
      const distance = c.start >= a.end ? c.start - a.end : a.start >= c.end ? a.start - c.end : 0;
      if (distance <= NEAR && (!best || distance < best.distance))
        best = { code: c.code, distance };
    }
  }
  return best?.code ?? null;
}

const BLOCKS =
  "address,article,aside,blockquote,br,dd,div,dl,dt,footer,h1,h2,h3,h4,h5,h6,header,hr,li,ol,p,pre,section,table,tr,ul";

/**
 * The words of an HTML body with blocks kept apart ("code:</p><p>779693" must not read "code:779693"). Table
 * cells holding one character stay joined, so a code laid out one digit per cell reads as one code.
 */
export function htmlText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("style, script, head, template, noscript").forEach((el) => el.remove());
  doc.querySelectorAll(BLOCKS).forEach((el) => el.append(" "));
  doc.querySelectorAll("td, th").forEach((el) => {
    if ((el.textContent ?? "").trim().length > 1) el.append(" ");
  });
  return (doc.body?.textContent ?? "").replace(/\s+/g, " ");
}

/** The code in one message: its subject and snippet first (cheap), then the body. */
export function messageCode(message: MessageDetail): string | null {
  return (
    findCode(`${message.subject ?? ""}. ${message.snippet ?? ""}`) ??
    (message.bodyText ? findCode(message.bodyText) : null) ??
    (message.bodyHtml ? findCode(htmlText(message.bodyHtml)) : null)
  );
}

/** The newest code in a conversation (drafts don't count), with the message it came from. */
export function conversationCode(
  messages: readonly MessageDetail[],
): { code: string; messageId: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.labelIds.includes("DRAFT")) continue;
    const code = messageCode(message);
    if (code) return { code, messageId: message.id };
  }
  return null;
}

/** How long the list offers a code: they expire within minutes, and old ones are clutter. */
export const LIST_CODE_MAX_AGE = 60 * 60_000;

/** The code a conversation row offers: from the subject and snippet, only while the email is recent. */
export function rowCode(thread: Pick<ThreadSummary, "subject" | "snippet" | "date">, now: number) {
  if (!thread.date || now - thread.date > LIST_CODE_MAX_AGE) return null;
  return findCode(`${thread.subject ?? ""}. ${thread.snippet ?? ""}`);
}
