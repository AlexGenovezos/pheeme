import { useCalendarStore } from "../calendar/calendarStore";
import type { DiagnosticsEmail, DiagnosticsImage } from "../lib/tauri";
import { IMAGE_RETRIES } from "../mail/imageRetry";
import { parseThreadKey, type ThreadKey } from "../mail/mailboxes";
import { useThreadStore } from "../store/threadStore";
import { useUiStore } from "../store/uiStore";

/**
 * The conversation open behind Settings, which Send diagnostics can include ("Include the email on screen"). Settings
 * is a dialog over the app, so the reading pane and its email frames are still mounted underneath.
 */
export interface EmailOnScreen {
  key: ThreadKey;
  subject: string | null;
}

/** The open conversation in Mail mode, once its data is in memory; else null. */
export function useEmailOnScreen(): EmailOnScreen | null {
  const key = useUiStore((s) => s.openThread);
  const mail = useCalendarStore((s) => s.mode === "mail");
  const detail = useThreadStore((s) => (key ? s.details.get(key) : undefined));
  if (!key || !mail || !detail) return null;
  return { key, subject: detail.thread.subject ?? detail.messages[0]?.subject ?? null };
}

/** Whether an image source could be fetched over the network: parsed as a URL would be, so tabs, newlines and
 *  case don't hide the scheme. Anything that doesn't parse counts too. */
function mayBeRemote(src: string): boolean {
  try {
    return /^https?:$/.test(new URL(src).protocol);
  } catch {
    return true;
  }
}

/** The open conversation's root in the reading pane (`ThreadView`), not the neighbours kept rendered out of sight. */
const OPEN_ROOT = '.thread-view__retained[data-visible="true"]';

/** What the window sees of every image in the open conversation's email frames, right now. */
export function imagesOnScreen(doc: Document = document): DiagnosticsImage[] {
  const bodies = doc.querySelectorAll<HTMLElement>(`${OPEN_ROOT} .email-body[data-message-id]`);
  return [...bodies].flatMap((body) => {
    const frame = body.querySelector("iframe");
    // A Spam message's remote images not shown yet: reporting them as failed would have the backend fetch them.
    const held = body.hasAttribute("data-images-held");
    const images = [...(frame?.contentDocument?.images ?? [])].filter(
      (img) => !held || !mayBeRemote(img.getAttribute("src") ?? ""),
    );
    return images.map((img) => ({
      messageId: body.dataset.messageId ?? null,
      src: img.getAttribute("src") ?? "",
      currentSrc: img.currentSrc,
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      loading: img.getAttribute("loading") ?? "",
      retries: Number(img.getAttribute(IMAGE_RETRIES)) || 0,
    }));
  });
}

/** The request the backend reads the email from, with the images as they are at this moment. */
export function emailRequest(key: ThreadKey, doc: Document = document): DiagnosticsEmail {
  return {
    ...parseThreadKey(key),
    images: imagesOnScreen(doc),
    online: doc.defaultView?.navigator.onLine ?? true,
  };
}
