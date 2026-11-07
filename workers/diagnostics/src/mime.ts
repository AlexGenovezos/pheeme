// A plain-text RFC 5322 message, built by hand so the Worker needs no MIME
// library. Inputs reaching headers are already free of line breaks
// (`handleUpload` validates them); non-ASCII is RFC 2047-encoded.

export interface MimeInput {
  from: string;
  fromName: string;
  to: string;
  replyTo: string | null;
  subject: string;
  text: string;
  /** Including angle brackets, e.g. `<id@pheeme.email>`. */
  messageId: string;
  date: Date;
}

const CRLF = "\r\n";
// 39 bytes → 52 base64 characters, so "Subject: " plus one encoded word stays
// under the recommended 78-character line.
const WORD_BYTES = 39;
// 57 bytes → exactly 76 base64 characters per body line.
const BODY_LINE_BYTES = 57;

export function buildMime(m: MimeInput): string {
  const headers = [
    `From: ${encodeHeader(m.fromName)} <${m.from}>`,
    `To: ${m.to}`,
    ...(m.replyTo ? [`Reply-To: ${m.replyTo}`] : []),
    `Subject: ${encodeHeader(m.subject)}`,
    `Message-ID: ${m.messageId}`,
    `Date: ${m.date.toUTCString().replace("GMT", "+0000")}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  const bytes = new TextEncoder().encode(m.text.replace(/\r?\n/g, CRLF));
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += BODY_LINE_BYTES) {
    lines.push(base64(bytes.subarray(i, i + BODY_LINE_BYTES)));
  }
  return headers.join(CRLF) + CRLF + CRLF + lines.join(CRLF) + CRLF;
}

/** Printable ASCII passes through; anything else becomes folded RFC 2047
 * `B` words, split on character boundaries. */
export function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const encoder = new TextEncoder();
  const words: number[][] = [];
  let current: number[] = [];
  for (const char of value) {
    const bytes = encoder.encode(char);
    if (current.length + bytes.length > WORD_BYTES) {
      words.push(current);
      current = [];
    }
    current.push(...bytes);
  }
  if (current.length) words.push(current);
  return words.map((w) => `=?UTF-8?B?${base64(Uint8Array.from(w))}?=`).join(`${CRLF} `);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
