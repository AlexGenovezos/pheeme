// Images pasted into a message's text. Each is a staged attachment with a Content-ID that Rust made
// (`…@pheeme.app`); the body shows it as `<img src="cid:…">`, which is how it is sent and saved in Gmail.
import { type ComposeDraft, readStagedAttachment, type StagedAttachment } from "../lib/tauri";

/** Image types every mail client shows in the text; other pasted files are attached. */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export const isInlineImageFile = (file: File) => INLINE_TYPES.has(file.type.toLowerCase());

/** An image this app put in a message's text (pasted here, or in an earlier save of the draft). */
export const isPastedImage = (a: StagedAttachment) =>
  !!a.contentId && a.contentId.toLowerCase().endsWith("@pheeme.app");

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
const urls = new Map<string, { stagedId: string; url: Promise<string | null> }>();

/** A pasted image's bytes are in hand already; show them without asking Rust. */
export function rememberImage(att: StagedAttachment, blob: Blob) {
  if (!att.contentId) return;
  urls.set(att.contentId, { stagedId: att.id, url: Promise.resolve(URL.createObjectURL(blob)) });
}

/** Where the editor reads the image `cid:` names from, or `null` when none of `attachments` has it. */
export function inlineImageUrl(
  contentId: string,
  attachments: StagedAttachment[],
): Promise<string | null> {
  const known = urls.get(contentId);
  if (known) return known.url;
  const att = attachments.find((a) => a.contentId === contentId);
  if (!att) return Promise.resolve(null);
  const url = readStagedAttachment(att.id).then(
    (bytes) => URL.createObjectURL(new Blob([bytes], { type: att.mimeType })),
    () => {
      urls.delete(contentId);
      return null;
    },
  );
  urls.set(contentId, { stagedId: att.id, url });
  return url;
}

/** The staged files went away (the panel closed): let their images go too. */
export function forgetImages(stagedIds: string[]) {
  const gone = new Set(stagedIds);
  for (const [cid, entry] of urls) {
    if (!gone.has(entry.stagedId)) continue;
    urls.delete(cid);
    void entry.url.then((url) => url && URL.revokeObjectURL(url));
  }
}
