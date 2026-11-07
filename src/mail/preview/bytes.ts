import { readAttachment } from "../../lib/tauri";

/** Recently previewed files kept in memory, so flipping back and forth is instant. */
const KEEP = 6;
const recent = new Map<string, Promise<ArrayBuffer>>();

const keyOf = (accountId: string, messageId: string, attachmentId: string) =>
  `${accountId}\u0000${messageId}\u0000${attachmentId}`;

/**
 * An attachment's bytes, shared by every caller asking for the same file. A failed read is
 * forgotten, so the next attempt tries again.
 */
export function attachmentBytes(
  accountId: string,
  messageId: string,
  attachmentId: string,
): Promise<ArrayBuffer> {
  const key = keyOf(accountId, messageId, attachmentId);
  const hit = recent.get(key);
  if (hit) {
    recent.delete(key);
    recent.set(key, hit);
    return hit;
  }
  const read = readAttachment(accountId, messageId, attachmentId);
  recent.set(key, read);
  read.catch(() => {
    if (recent.get(key) === read) recent.delete(key);
  });
  while (recent.size > KEEP) recent.delete(recent.keys().next().value!);
  return read;
}

/** For tests. */
export function clearAttachmentBytes() {
  recent.clear();
}
