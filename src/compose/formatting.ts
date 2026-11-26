// Gmail's formatting options for the compose and signature editors, written as the HTML Gmail itself sends so
// other mail clients show the message the same way: `<font face>`, `<font size>` and `<font color>` for the font,
// size and text colour, a `background-color` span for highlighting, `text-align` and `margin-left` styles on a
// paragraph for alignment and indenting, and Gmail's inline-styled `<blockquote>` for Quote. No classes: the mail
// is read without our stylesheet. Pheeme's own reader keeps all of it (`render.rs`, `compose/template.rs`).
import { type Editor, Extension, Mark } from "@tiptap/react";

/** Gmail's fonts: the menu's names and the `face` it writes. Sans Serif is the default, written as no font. */
export const FONTS: ReadonlyArray<{ name: string; face: string | null }> = [
  { name: "Sans Serif", face: null },
  { name: "Serif", face: "times new roman, serif" },
  { name: "Fixed width", face: "monospace" },
  { name: "Wide", face: "arial black, sans-serif" },
  { name: "Narrow", face: "arial narrow, sans-serif" },
  { name: "Comic Sans MS", face: "comic sans ms, sans-serif" },
  { name: "Garamond", face: "garamond, serif" },
  { name: "Georgia", face: "georgia, serif" },
  { name: "Tahoma", face: "tahoma, sans-serif" },
  { name: "Trebuchet MS", face: "trebuchet ms, sans-serif" },
  { name: "Verdana", face: "verdana, sans-serif" },
];

/** Gmail's sizes and the `<font size>` each writes; Normal is no size. */
export const SIZES: ReadonlyArray<{ name: string; size: string | null }> = [
  { name: "Small", size: "1" },
  { name: "Normal", size: null },
  { name: "Large", size: "4" },
  { name: "Huge", size: "6" },
];

/** The font name for a `face` (ignoring case and spaces), or the face itself when it isn't one of Gmail's. */
export function fontName(face: string | null | undefined): string {
  if (!face) return FONTS[0].name;
  const key = face.toLowerCase().replace(/\s*,\s*/g, ",");
  return FONTS.find((f) => f.face?.replace(/\s*,\s*/g, ",") === key)?.name ?? face;
}

const HUES = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "magenta"];
const GREYS = [
  "black",
  "dark grey 4",
  "dark grey 3",
  "dark grey 2",
  "grey",
  "light grey 1",
  "light grey 2",
  "white",
];
const SHADES = ["", "light 3", "light 2", "light 1", "dark 1", "dark 2", "dark 3"];

/** Gmail's text and background colour palette, eight to a row: greys, bright hues, then three tints and three shades. */
export const PALETTE: ReadonlyArray<{ color: string; name: string }> = [
  ["#000000", "#444444", "#666666", "#999999", "#cccccc", "#eeeeee", "#f3f3f3", "#ffffff"],
  ["#ff0000", "#ff9900", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#9900ff", "#ff00ff"],
  ["#f4cccc", "#fce5cd", "#fff2cc", "#d9ead3", "#d0e0e3", "#cfe2f3", "#d9d2e9", "#ead1dc"],
  ["#ea9999", "#f9cb9c", "#ffe599", "#b6d7a8", "#a2c4c9", "#9fc5e8", "#b4a7d6", "#d5a6bd"],
  ["#e06666", "#f6b26b", "#ffd966", "#93c47d", "#76a5af", "#6fa8dc", "#8e7cc3", "#c27ba0"],
  ["#cc0000", "#e69138", "#f1c232", "#6aa84f", "#45818e", "#3d85c6", "#674ea7", "#a64d79"],
  ["#990000", "#b45f06", "#bf9000", "#38761d", "#134f5c", "#0b5394", "#351c75", "#741b47"],
  ["#660000", "#783f04", "#7f6000", "#274e13", "#0c343d", "#073763", "#20124d", "#4c1130"],
].flatMap((row, r) =>
  row.map((color, c) => ({
    color,
    name: r === 0 ? GREYS[c] : `${SHADES[r - 1]} ${HUES[c]}`.trim(),
  })),
);

export type Align = "left" | "center" | "right";

/** How far one step of Indent more moves a paragraph, as Gmail does it. */
const INDENT_PX = 40;
const MAX_INDENT = 10;

/** The style Gmail writes on a quote (Quote in the formatting bar), so it reads as one everywhere. */
export const QUOTE_STYLE =
  "margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex";

/** A mark written as `<font name="…">`, read back from any `<font>` carrying that attribute. */
function fontMark(markName: string, attribute: "face" | "size" | "color", valid: RegExp) {
  return Mark.create({
    name: markName,
    addAttributes() {
      // Read as text: TipTap would otherwise turn `size="4"` into a number.
      return {
        [attribute]: {
          default: null,
          rendered: false,
          parseHTML: (el: HTMLElement) => el.getAttribute(attribute)?.trim() || null,
        },
      };
    },
    parseHTML() {
      return [
        {
          tag: `font[${attribute}]`,
          // One `<font face size color>` carries three marks: let the other rules read it too.
          consuming: false,
          getAttrs: (el: HTMLElement) =>
            valid.test(el.getAttribute(attribute)?.trim() ?? "") ? null : false,
        },
      ];
    },
    renderHTML({ mark }) {
      return ["font", { [attribute]: mark.attrs[attribute] }, 0];
    },
  });
}

export const FontFace = fontMark("fontFace", "face", /^[\w\s,'"-]{1,100}$/);
export const FontSize = fontMark("fontSize", "size", /^[1-7]$/);
export const TextColor = fontMark("textColor", "color", /^#[0-9a-f]{3,8}$|^[a-z]{3,20}$/i);

/** Highlighting: `<span style="background-color:…">`, as Gmail writes it. */
export const BackgroundColor = Mark.create({
  name: "backgroundColor",
  addAttributes() {
    return {
      color: {
        default: null,
        rendered: false,
        parseHTML: (el: HTMLElement) => el.style.backgroundColor || null,
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: "span[style]",
        consuming: false,
        getAttrs: (el: HTMLElement) => {
          const color = el.style.backgroundColor;
          return color && color !== "transparent" ? null : false;
        },
      },
    ];
  },
  renderHTML({ mark }) {
    return ["span", { style: `background-color:${String(mark.attrs.color)}` }, 0];
  },
});

/** The marks Remove formatting takes off: everything but links. */
const isFormatting = (name: string) => name !== "link";

/** Remove formatting (`mod+\`): the selection's marks (font, size, colours, bold, …) go, its links stay. */
export function removeFormatting(editor: Editor) {
  return editor
    .chain()
    .focus()
    .command(({ tr, state }) => {
      const { from, to, empty } = state.selection;
      const marks = Object.values(state.schema.marks).filter((m) => isFormatting(m.name));
      if (empty) {
        const stored = state.storedMarks ?? state.selection.$from.marks();
        tr.setStoredMarks(stored.filter((m) => !isFormatting(m.type.name)));
      } else for (const mark of marks) tr.removeMark(from, to, mark);
      return true;
    })
    .run();
}

/** The paragraphs in the selection that aren't in a list (a list item indents by nesting instead). */
function selectedParagraphs(editor: Editor) {
  const { state } = editor;
  const found: Array<{ pos: number; indent: number }> = [];
  const { from, to } = state.selection;
  state.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (node.type.name === "listItem") return false;
    if (node.type.name !== "paragraph" || parent?.type.name === "listItem") return true;
    found.push({ pos, indent: Number(node.attrs.indent) || 0 });
    return false;
  });
  return found;
}

/** Indent more (`delta` 1) or less (-1), like Gmail: a list item nests or un-nests, a paragraph moves 40px. */
export function indent(editor: Editor, delta: 1 | -1) {
  if (editor.isActive("listItem")) {
    const chain = editor.chain().focus();
    return (delta > 0 ? chain.sinkListItem("listItem") : chain.liftListItem("listItem")).run();
  }
  const paragraphs = selectedParagraphs(editor);
  const stored = editor.state.storedMarks;
  return editor
    .chain()
    .focus()
    .command(({ tr, state }) => {
      let changed = false;
      for (const { pos, indent: was } of paragraphs) {
        const next = Math.max(0, Math.min(MAX_INDENT, was + delta));
        if (next === was) continue;
        const node = state.doc.nodeAt(pos);
        if (!node) continue;
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next || null });
        changed = true;
      }
      // Changing the paragraph would drop a size or font chosen for the text about to be typed.
      if (stored) tr.setStoredMarks(stored);
      return changed;
    })
    .run();
}

/** Align the selected paragraphs; left is the default and is written as no alignment. */
export function align(editor: Editor, to: Align) {
  const stored = editor.state.storedMarks;
  return editor
    .chain()
    .focus()
    .updateAttributes("paragraph", { textAlign: to === "left" ? null : to })
    .command(({ tr }) => {
      // As for indenting: keep the formatting chosen for the text about to be typed.
      if (stored) tr.setStoredMarks(stored);
      return true;
    })
    .run();
}

/** The alignment of the paragraph the selection starts in. */
export function alignmentOf(editor: Editor): Align {
  const value = editor.getAttributes("paragraph").textAlign as unknown;
  return value === "center" || value === "right" ? value : "left";
}

const ALIGNS = new Set(["center", "right", "justify"]);

/**
 * Alignment and indenting on paragraphs, written as inline styles (`text-align`, `margin-left`), and Gmail's
 * style on quotes. Read back from the same styles, so a saved draft opens as it was.
 */
export const BlockFormat = Extension.create({
  name: "blockFormat",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph"],
        attributes: {
          textAlign: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const value = el.style.textAlign || el.getAttribute("align") || "";
              return ALIGNS.has(value) ? value : null;
            },
            renderHTML: (attrs: Record<string, unknown>) =>
              attrs.textAlign ? { style: `text-align:${String(attrs.textAlign)}` } : {},
          },
          indent: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const px = Number.parseFloat(el.style.marginLeft);
              const steps = Number.isFinite(px) ? Math.round(px / INDENT_PX) : 0;
              return steps > 0 ? Math.min(steps, MAX_INDENT) : null;
            },
            renderHTML: (attrs: Record<string, unknown>) =>
              attrs.indent ? { style: `margin-left:${Number(attrs.indent) * INDENT_PX}px` } : {},
          },
        },
      },
      {
        types: ["blockquote"],
        attributes: {
          // Not read from the HTML: every quote the editor writes carries Gmail's style.
          quoteStyle: {
            default: true,
            parseHTML: () => true,
            renderHTML: () => ({ style: QUOTE_STYLE }),
          },
        },
      },
    ];
  },
});

/**
 * Gmail's formatting shortcuts that TipTap doesn't already have (it has bold, italic, underline, undo, redo and the
 * lists on `mod+shift+7`/`8`). None of them is a Pheeme shortcut, and a compose panel owns its keys anyway.
 */
export const GMAIL_KEYS = {
  strike: "mod+shift+x",
  quote: "mod+shift+9",
  removeFormatting: "mod+\\",
  indentLess: "mod+[",
  indentMore: "mod+]",
  alignLeft: "mod+shift+l",
  alignCenter: "mod+shift+e",
  alignRight: "mod+shift+r",
  bulleted: "mod+shift+8",
  numbered: "mod+shift+7",
  undo: "mod+z",
  redo: "mod+y",
} as const;

/** `mod+shift+x` → TipTap's `Mod-Shift-x`. */
const tiptapKey = (shortcut: string) =>
  shortcut
    .split("+")
    .map((part) => (part === "mod" ? "Mod" : part === "shift" ? "Shift" : part))
    .join("-");

export const FormatShortcuts = Extension.create({
  name: "formatShortcuts",
  addKeyboardShortcuts() {
    const editor = this.editor;
    const keys: Array<[string, () => boolean]> = [
      [GMAIL_KEYS.strike, () => editor.commands.toggleStrike()],
      [GMAIL_KEYS.quote, () => editor.commands.toggleBlockquote()],
      [GMAIL_KEYS.removeFormatting, () => removeFormatting(editor)],
      [GMAIL_KEYS.indentLess, () => indent(editor, -1)],
      [GMAIL_KEYS.indentMore, () => indent(editor, 1)],
      [GMAIL_KEYS.alignLeft, () => align(editor, "left")],
      [GMAIL_KEYS.alignCenter, () => align(editor, "center")],
      [GMAIL_KEYS.alignRight, () => align(editor, "right")],
    ];
    return Object.fromEntries(keys.map(([key, run]) => [tiptapKey(key), run]));
  },
});

/** Everything the formatting bar needs beyond StarterKit. */
export const FORMATTING = [
  FontFace,
  FontSize,
  TextColor,
  BackgroundColor,
  BlockFormat,
  FormatShortcuts,
];
