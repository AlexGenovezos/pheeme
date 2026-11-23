// Images pasted into a message's text. The window names each with a Content-ID (`…@pheeme.app`) and puts it in the
// text at once as `<img src="cid:…">`, which is how it is sent and saved in Gmail; its bytes are staged beside it.
import { type ComposeDraft, readStagedAttachment, type StagedAttachment } from "../lib/tauri";

/** Image types every mail client shows in the text; other pasted files are attached. */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export const isInlineImageFile = (file: File) => INLINE_TYPES.has(file.type.toLowerCase());

const PASTED_DOMAIN = "@pheeme.app";

/** A new Content-ID for a pasted image (Rust accepts only this shape). */
export const newContentId = () => `${crypto.randomUUID().replace(/-/g, "")}${PASTED_DOMAIN}`;

/** An image this app put in a message's text (pasted here, or in an earlier save of the draft). */
export const isPastedImage = (a: StagedAttachment) =>
  !!a.contentId && a.contentId.toLowerCase().endsWith(PASTED_DOMAIN);

export const cidSrc = (contentId: string) => `cid:${contentId}`;

const shows = (html: string | null | undefined, contentId: string) =>
  !!html && html.toLowerCase().includes(cidSrc(contentId).toLowerCase());

/**
 * The message as it goes to Gmail: a pasted image deleted from the text is left out. Its staged file stays
 * until the panel closes, so undoing the delete brings it back.
 */
export function outgoingDraft(draft: ComposeDraft): ComposeDraft {
  const kept = draft.attachments.filter(
    (a) =>
      !isPastedImage(a) ||
      shows(draft.bodyHtml, a.contentId!) ||
      shows(draft.quoteHtml, a.contentId!),
  );
  return kept.length === draft.attachments.length ? draft : { ...draft, attachments: kept };
}

/** What editors show while a pasted image's file is being staged: its bytes in hand, by Content-ID. */
const pendingUrls = new Map<string, string>();
/** What editors show once it is staged, by staged attachment id (two drafts may share a Content-ID). */
const stagedUrls = new Map<string, Promise<string | null>>();

/** A pasted image is being staged under `contentId`: show it from `blob` meanwhile. */
export function stagingImage(contentId: string, blob: Blob) {
  pendingUrls.set(contentId, URL.createObjectURL(blob));
}

/** Staging ended: the image is now `att`'s, or (`null`) it failed and goes. */
export function stagedImage(contentId: string, att: StagedAttachment | null) {
  const url = pendingUrls.get(contentId);
  pendingUrls.delete(contentId);
  if (!url) return;
  if (att) stagedUrls.set(att.id, Promise.resolve(url));
  else URL.revokeObjectURL(url);
}

/**
 * Where an editor reads the image `cid:` names: the panel's staged file (from `attachments`), or the pasted bytes
 * while it is being staged; `null` when there is neither (an image copied from another panel, which wouldn't be sent).
 */
export function inlineImageUrl(
  contentId: string,
  attachments: StagedAttachment[],
): Promise<string | null> {
  const att = attachments.find((a) => a.contentId === contentId);
  if (!att) return Promise.resolve(pendingUrls.get(contentId) ?? null);
  const known = stagedUrls.get(att.id);
  if (known) return known;
  const url = readStagedAttachment(att.id).then(
    (bytes) => URL.createObjectURL(new Blob([bytes], { type: att.mimeType })),
    () => {
      stagedUrls.delete(att.id);
      return null;
    },
  );
  stagedUrls.set(att.id, url);
  return url;
}

/** The staged files went away (the panel closed): let their images go too. */
export function forgetImages(attachments: StagedAttachment[]) {
  for (const { id } of attachments) {
    const url = stagedUrls.get(id);
    if (!url) continue;
    stagedUrls.delete(id);
    void url.then((u) => u && URL.revokeObjectURL(u));
  }
}

/** `html` without the images whose `cid:` names one of `contentIds`. */
export function withoutImages(html: string, contentIds: string[]): string {
  const ids = new Set(contentIds.map((id) => id.toLowerCase()));
  return html.replace(/<img\b[^>]*\bsrc="cid:([^"]+)"[^>]*>/gi, (img, id: string) =>
    ids.has(id.toLowerCase()) ? "" : img,
  );
}
