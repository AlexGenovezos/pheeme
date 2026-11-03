import type { ReactNode } from "react";
import { toast } from "../components/ui/Toast";
import { openMailLink, toCommandError } from "../lib/tauri";

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
const TRAILING_PUNCTUATION = /[.,;:!?'"]$/;
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Drop sentence punctuation after a URL, and a closing bracket the URL never opened. */
function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    if (TRAILING_PUNCTUATION.test(url)) {
      url = url.slice(0, -1);
      continue;
    }
    const last = url.charAt(url.length - 1);
    const opener = last ? CLOSERS[last] : undefined;
    if (opener && url.split(last as string).length > url.split(opener).length) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

function open(url: string) {
  openMailLink(url).catch((error) => toast({ title: "Couldn't open the link", description: toCommandError(error).message, tone: "danger" }));
}

/**
 * Plain text with http(s) URLs turned into buttons that open through the backend. Everything else stays a
 * string, so React escapes it: `<b>` in a message is shown literally.
 */
export function linkify(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let from = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    if (match.index > from) nodes.push(text.slice(from, match.index));
    nodes.push(
      <button key={match.index} type="button" className="link-button" title={url} onClick={() => open(url)}>
        {url}
      </button>,
    );
    from = match.index + url.length;
  }
  if (from < text.length) nodes.push(text.slice(from));
  return nodes;
}
