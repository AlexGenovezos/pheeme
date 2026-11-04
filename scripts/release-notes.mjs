// The release-notes format, shared by `release:check` (scripts/release.mjs) and the app's
// Settings › About › What's new (src/settings/ReleaseNotes.tsx). Notes are a small subset of
// Markdown so the app can show them without a Markdown library:
//
//   A paragraph, which may run over several lines.
//
//   **A heading** (a line that is only bold text)
//   - a bullet with **bold**, `code` and [a link](https://pheeme.app/…)
//
// Links must be https on github.com or pheeme.app, the hosts the app may open
// (EXTERNAL_HOSTS in src-tauri/src/commands/mod.rs). Anything else is an error, so a release
// can't ship notes the app would show wrong. Types: release-notes.d.mts.

export const LINK_HOSTS = ["github.com", "pheeme.app"];

/** The notes without HTML comments (the writing guide at the top). */
export const stripComments = (text) => text.replace(/<!--[\s\S]*?-->\n?/g, "");

const parts = (v) => v.split(".").map(Number);
/** a > b for MAJOR.MINOR[.PATCH] strings. */
export function isNewer(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

function linkAllowed(href) {
  try {
    const url = new URL(href);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      LINK_HOSTS.includes(url.hostname)
    );
  } catch {
    return false;
  }
}

const INLINE = /\*\*([^*]+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
/** Markdown the format doesn't support, if it's left in plain text. */
const UNSUPPORTED_INLINE = [
  [/\*/, "a stray * (only **bold** is supported)"],
  [/`/, "a stray `"],
  [/\]\(/, "a malformed link"],
  [/<\/?[a-z]/i, "HTML"],
  [/(^|[^\w])_[^_\s][^_]*_(?!\w)/, "_italics_ (only **bold** is supported)"],
  [/\\[\\`*_{}[\]()#+\-.!>|]/, "a backslash escape"],
];

/** `line` as inline pieces, adding any problem to `errors`. */
function parseInline(line, lineNo, errors) {
  const out = [];
  if (/!\[[^\]]*\]\(/.test(line)) errors.push(`line ${lineNo}: an image`);
  const text = (s) => {
    if (!s) return;
    for (const [re, what] of UNSUPPORTED_INLINE)
      if (re.test(s)) errors.push(`line ${lineNo}: ${what}`);
    out.push({ type: "text", text: s });
  };
  let last = 0;
  for (const m of line.matchAll(INLINE)) {
    text(line.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) {
      if (/[`[]/.test(m[1])) errors.push(`line ${lineNo}: code or a link inside **bold**`);
      out.push({ type: "bold", text: m[1] });
    } else if (m[2] !== undefined) {
      out.push({ type: "code", text: m[2] });
    } else {
      if (!linkAllowed(m[4]))
        errors.push(`line ${lineNo}: link to ${m[4]} (only https ${LINK_HOSTS.join(" or ")})`);
      if (/[*`[\]]/.test(m[3])) errors.push(`line ${lineNo}: formatting inside link text`);
      out.push({ type: "link", text: m[3], href: m[4] });
    }
  }
  text(line.slice(last));
  return out;
}

const UNSUPPORTED_LINE = [
  [/^#/, "a # heading (use a line of **bold** text)"],
  [/^>/, "a quote"],
  [/^\|/, "a table"],
  [/^[*+] /, "a * or + bullet (use -)"],
  [/^\d+[.)] /, "a numbered list"],
  [/^\s+\S/, "an indented line (nested lists and code blocks aren't supported)"],
  [/^(```|~~~)/, "a code block"],
  [/^(-{3,}|\*{3,}|_{3,})\s*$/, "a horizontal rule"],
];

/**
 * Notes text (comments included) as blocks, with every unsupported construct in `errors`.
 * @returns {{ blocks: import("./release-notes.d.mts").NotesBlock[], errors: string[] }}
 */
export function parseNotes(text) {
  const blocks = [];
  const errors = [];
  let paragraph = null;
  let list = null;
  const end = () => {
    paragraph = null;
    list = null;
  };

  // Comments become blank lines, so line numbers still match the file.
  const lines = text
    .replace(/<!--[\s\S]*?-->/g, (c) => "\n".repeat(c.split("\n").length - 1))
    .split("\n");
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.replace(/\s+$/, "");
    if (!line) return end();
    const bad = UNSUPPORTED_LINE.find(([re]) => re.test(line));
    if (bad) {
      errors.push(`line ${lineNo}: ${bad[1]}`);
      return end();
    }
    const heading = /^\*\*([^*]+)\*\*$/.exec(line);
    if (heading) {
      end();
      blocks.push({ type: "heading", text: heading[1] });
    } else if (line.startsWith("- ")) {
      paragraph = null;
      if (!list) blocks.push((list = { type: "list", items: [] }));
      list.items.push(parseInline(line.slice(2).trim(), lineNo, errors));
    } else if (list) {
      errors.push(`line ${lineNo}: a bullet continued on the next line (keep each on one line)`);
    } else if (paragraph) {
      paragraph.content.push({ type: "text", text: " " }, ...parseInline(line, lineNo, errors));
    } else {
      blocks.push((paragraph = { type: "paragraph", content: parseInline(line, lineNo, errors) }));
    }
  });
  return { blocks, errors };
}
