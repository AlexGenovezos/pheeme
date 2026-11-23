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

/** Object URLs for the images shown in editors, by Content-ID. */
const urls = new Map<string, Promise<string | null>>();

/** A pasted image's bytes are in hand already; show them without asking Rust. */
export function rememberImage(contentId: string, blob: Blob) {
  urls.set(contentId, Promise.resolve(URL.createObjectURL(blob)));
}

/**
 * Where an editor reads the image `cid:` names, from the panel's `attachments`; `null` when the panel doesn't have
 * it (an image copied from another panel, which wouldn't be sent). `pending`: it was just pasted and is still being
 * staged, so it is shown from its bytes in hand.
 */
export function inlineImageUrl(
  contentId: string,
  attachments: StagedAttachment[],
  pending: boolean,
): Promise<string | null> {
  const att = attachments.find((a) => a.contentId === contentId);
  const known = urls.get(contentId);
  if (known && (att || pending)) return known;
  if (!att) return Promise.resolve(null);
  const url = readStagedAttachment(att.id).then(
    (bytes) => URL.createObjectURL(new Blob([bytes], { type: att.mimeType })),
    () => {
      urls.delete(contentId);
      return null;
    },
  );
  urls.set(contentId, url);
  return url;
}

/** The staged files went away (the panel closed): let their images go too. */
export function forgetImages(attachments: StagedAttachment[]) {
  for (const { contentId } of attachments) {
    const url = contentId ? urls.get(contentId) : undefined;
    if (!url) continue;
    urls.delete(contentId!);
    void url.then((u) => u && URL.revokeObjectURL(u));
  }
}
