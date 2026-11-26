// The formatting bar under the compose and signature editors: Gmail's options in Gmail's order (undo, redo,
// font, size, bold, italic, underline, colour, align, lists, then More for indenting, quote, strikethrough and
// remove formatting) and the link. Every menu opens upward in a popover, so the bar keeps its size and nothing
// on the page moves when one opens.
import { type Editor as TipTap, useEditorState } from "@tiptap/react";
import {
  ALargeSmall,
  Baseline,
  Bold,
  ChevronDown,
  Italic,
  Link2,
  List,
  ListOrdered,
  MoreVertical,
  Redo2,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
  Underline,
  Undo2,
} from "lucide-react";
import { type FormEvent, type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { IconButton } from "../components/ui/IconButton";
import { Menu, type MenuItem } from "../components/ui/Menu";
import { usePopover } from "../components/ui/usePopover";
import { textOn } from "../calendar/colors";
import { type Swatch, SwatchGrid } from "../labels/ColorPopover";
import { cx } from "../lib/utils";
import { aboveOf, Floating } from "./floating";
import {
  align,
  type Align,
  alignmentOf,
  FONTS,
  fontName,
  GMAIL_KEYS,
  indent,
  PALETTE,
  removeFormatting,
  SIZES,
} from "./formatting";
import "../labels/labels.css";
import "../components/ui/Surface.css";

type Open = {
  kind: "font" | "size" | "align" | "more" | "colour" | "link";
  at: { x: number; y: number };
};

const ALIGN_ICONS: Record<Align, ReactNode> = {
  left: <TextAlignStart />,
  center: <TextAlignCenter />,
  right: <TextAlignEnd />,
};

/** Keeps the selection in the editor when a bar button is pressed with the mouse. */
const keepSelection = (e: React.MouseEvent) => e.preventDefault();

export function FormatBar({ editor }: { editor: TipTap }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      quote: e.isActive("blockquote"),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      link: e.isActive("link"),
      face: (e.getAttributes("fontFace").face as string | undefined) ?? null,
      size: (e.getAttributes("fontSize").size as string | undefined) ?? null,
      color: (e.getAttributes("textColor").color as string | undefined) ?? null,
      background: (e.getAttributes("backgroundColor").color as string | undefined) ?? null,
      align: alignmentOf(e),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const [open, setOpen] = useState<Open | null>(null);
  const openers = useRef<Partial<Record<Open["kind"], HTMLButtonElement | null>>>({});
  const close = () => setOpen(null);
  const toggle = (kind: Open["kind"]) => {
    const button = openers.current[kind];
    if (!button) return;
    setOpen((o) => (o?.kind === kind ? null : { kind, at: aboveOf(button) }));
  };
  /** The button that opened the open menu: pressing it again closes the menu rather than reopening it. */
  const isOpener = (target: Node) => !!open && !!openers.current[open.kind]?.contains(target);
  const chain = () => editor.chain().focus();

  const button = (
    label: string,
    on: boolean,
    icon: ReactNode,
    run: () => void,
    shortcut?: string,
    disabled?: boolean,
  ) => (
    <IconButton
      size="sm"
      label={label}
      shortcut={shortcut}
      icon={icon}
      aria-pressed={on}
      disabled={disabled}
      className={cx("compose-toolbar__button", on && "compose-toolbar__button--on")}
      onMouseDown={keepSelection}
      onClick={run}
    />
  );

  /** A bar button that opens a menu or popover: its content, then (for a choice) a small arrow. */
  const opener = (
    kind: Open["kind"],
    label: string,
    content: ReactNode,
    {
      caret = true,
      wide = false,
      pressed,
    }: { caret?: boolean; wide?: boolean; pressed?: boolean } = {},
  ) => (
    <button
      type="button"
      ref={(el) => {
        openers.current[kind] = el;
      }}
      className={cx(
        "ui-icon-button ui-icon-button--sm compose-toolbar__button",
        caret && "compose-toolbar__menu",
        wide && "compose-toolbar__menu--font",
        (open?.kind === kind || pressed) && "compose-toolbar__button--on",
      )}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      aria-haspopup={kind === "colour" || kind === "link" ? "dialog" : "menu"}
      aria-expanded={open?.kind === kind}
      onMouseDown={keepSelection}
      onClick={() => toggle(kind)}
    >
      {content}
      {caret && <ChevronDown className="compose-toolbar__caret" aria-hidden="true" />}
    </button>
  );

  const menus: Record<"font" | "size" | "align" | "more", { label: string; items: MenuItem[] }> = {
    font: {
      label: "Font",
      items: FONTS.map(({ name, face }) => ({
        id: name,
        label: name,
        checked: fontName(state.face) === name,
        labelStyle: { fontFamily: face ?? undefined },
        onSelect: () =>
          void (face
            ? chain().setMark("fontFace", { face }).run()
            : chain().unsetMark("fontFace").run()),
      })),
    },
    size: {
      label: "Size",
      items: SIZES.map(({ name, size }) => ({
        id: name,
        label: name,
        checked: state.size === size,
        onSelect: () =>
          void (size
            ? chain().setMark("fontSize", { size }).run()
            : chain().unsetMark("fontSize").run()),
      })),
    },
    align: {
      label: "Align",
      items: (
        [
          ["left", "Align left", GMAIL_KEYS.alignLeft],
          ["center", "Align centre", GMAIL_KEYS.alignCenter],
          ["right", "Align right", GMAIL_KEYS.alignRight],
        ] as const
      ).map(([to, label, shortcut]) => ({
        id: to,
        label,
        shortcut,
        checked: state.align === to,
        onSelect: () => void align(editor, to),
      })),
    },
    more: {
      label: "More formatting options",
      items: [
        {
          id: "indent-less",
          label: "Indent less",
          shortcut: GMAIL_KEYS.indentLess,
          onSelect: () => void indent(editor, -1),
        },
        {
          id: "indent-more",
          label: "Indent more",
          shortcut: GMAIL_KEYS.indentMore,
          onSelect: () => void indent(editor, 1),
        },
        { type: "separator" },
        {
          id: "quote",
          label: "Quote",
          shortcut: GMAIL_KEYS.quote,
          checked: state.quote,
          onSelect: () => void chain().toggleBlockquote().run(),
        },
        {
          id: "strike",
          label: "Strikethrough",
          shortcut: GMAIL_KEYS.strike,
          checked: state.strike,
          onSelect: () => void chain().toggleStrike().run(),
        },
        { type: "separator" },
        {
          id: "clear",
          label: "Remove formatting",
          shortcut: GMAIL_KEYS.removeFormatting,
          onSelect: () => void removeFormatting(editor),
        },
      ],
    },
  };

  return (
    <div className="compose-toolbar" role="toolbar" aria-label="Formatting">
      {button(
        "Undo",
        false,
        <Undo2 />,
        () => chain().undo().run(),
        GMAIL_KEYS.undo,
        !state.canUndo,
      )}
      {button(
        "Redo",
        false,
        <Redo2 />,
        () => chain().redo().run(),
        GMAIL_KEYS.redo,
        !state.canRedo,
      )}
      <span className="compose-toolbar__separator" />
      {opener(
        "font",
        "Font",
        <span className="compose-toolbar__font">{fontName(state.face)}</span>,
        { wide: true },
      )}
      <span className="compose-toolbar__separator" />
      {opener("size", "Size", <ALargeSmall />)}
      <span className="compose-toolbar__separator" />
      {button("Bold", state.bold, <Bold />, () => chain().toggleBold().run(), "mod+b")}
      {button("Italic", state.italic, <Italic />, () => chain().toggleItalic().run(), "mod+i")}
      {button(
        "Underline",
        state.underline,
        <Underline />,
        () => chain().toggleUnderline().run(),
        "mod+u",
      )}
      {opener("colour", "Text colour", <Baseline />)}
      <span className="compose-toolbar__separator" />
      {opener("align", "Align", ALIGN_ICONS[state.align])}
      {button(
        "Numbered list",
        state.ordered,
        <ListOrdered />,
        () => chain().toggleOrderedList().run(),
        GMAIL_KEYS.numbered,
      )}
      {button(
        "Bulleted list",
        state.bullet,
        <List />,
        () => chain().toggleBulletList().run(),
        GMAIL_KEYS.bulleted,
      )}
      {opener("more", "More formatting options", <MoreVertical />, { caret: false })}
      <span className="compose-toolbar__separator" />
      {opener("link", "Link", <Link2 />, { caret: false, pressed: state.link })}

      {open &&
        (open.kind === "font" ||
          open.kind === "size" ||
          open.kind === "align" ||
          open.kind === "more") && (
          <Floating>
            <Menu
              items={menus[open.kind].items}
              x={open.at.x}
              y={open.at.y}
              above
              ignore={isOpener}
              onClose={close}
              aria-label={menus[open.kind].label}
            />
          </Floating>
        )}
      {open?.kind === "colour" && (
        <Floating>
          <ColourPopover
            at={open.at}
            text={state.color}
            background={state.background}
            ignore={isOpener}
            onChoose={(mark, color) => {
              close();
              chain().setMark(mark, { color }).run();
            }}
            onClose={close}
          />
        </Floating>
      )}
      {open?.kind === "link" && (
        <Floating>
          <LinkPopover editor={editor} at={open.at} ignore={isOpener} onClose={close} />
        </Floating>
      )}
    </div>
  );
}

const SWATCHES: Swatch[] = PALETTE.map(({ color, name }) => ({
  value: color,
  name,
  background: color,
  foreground: textOn(color),
}));

/** Each grid's tab stop: its ticked swatch, else its first. */
const gridStops = (el: HTMLElement | null) => [
  ...(el?.querySelectorAll<HTMLElement>('.label-color__grid [tabindex="0"]') ?? []),
];

/** Gmail's colour menu: the background colour beside the text colour, each ticking the selection's. */
function ColourPopover({
  at,
  text,
  background,
  ignore,
  onChoose,
  onClose,
}: {
  at: Open["at"];
  text: string | null;
  background: string | null;
  ignore(target: Node): boolean;
  onChoose(mark: "textColor" | "backgroundColor", color: string): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { pos } = usePopover({
    ref,
    at,
    above: true,
    onClose,
    ignore,
    focusIn: (el) => gridStops(el)[0],
  });
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "Tab") {
      // The two grids, round and round, until it closes.
      const stops = gridStops(ref.current);
      const current = stops.findIndex((s) => s === document.activeElement);
      stops[(current + 1) % stops.length]?.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  // A background read back from the HTML is `rgb(…)`; the palette is hex.
  const hex = (color: string | null) => (color ? toHex(color) : null);

  return (
    <div
      ref={ref}
      className="label-color compose-colour popover-surface"
      role="dialog"
      aria-label="Colour"
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
    >
      <div className="compose-colour__part" role="group" aria-label="Background colour">
        <span className="compose-colour__title" aria-hidden="true">
          Background colour
        </span>
        <SwatchGrid
          swatches={SWATCHES}
          value={hex(background)}
          onChoose={(c) => onChoose("backgroundColor", c)}
        />
      </div>
      <div className="compose-colour__part" role="group" aria-label="Text colour">
        <span className="compose-colour__title" aria-hidden="true">
          Text colour
        </span>
        <SwatchGrid
          swatches={SWATCHES}
          value={hex(text)}
          onChoose={(c) => onChoose("textColor", c)}
        />
      </div>
    </div>
  );
}

/** `#rrggbb` for `#rgb`, `#rrggbb` or `rgb(r, g, b)`, lowercase; anything else as it is. */
function toHex(color: string): string {
  const c = color.trim().toLowerCase();
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(c);
  if (rgb)
    return `#${rgb
      .slice(1, 4)
      .map((n) => Number(n).toString(16).padStart(2, "0"))
      .join("")}`;
  if (/^#[0-9a-f]{3}$/.test(c)) return `#${[...c.slice(1)].map((d) => d + d).join("")}`;
  return c;
}

/** Set or clear the link on the selection. `window.prompt` doesn't exist in every webview, so it's a popover. */
function LinkPopover({
  editor,
  at,
  ignore,
  onClose,
}: {
  editor: TipTap;
  at: Open["at"];
  ignore(target: Node): boolean;
  onClose(): void;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const { pos } = usePopover({
    ref,
    at,
    above: true,
    onClose,
    ignore,
    focusIn: (el) => el?.querySelector("input"),
    // Back to the text, where the link now is.
    returnFocus: editor.view.dom,
  });
  const [href, setHref] = useState<string>(() => editor.getAttributes("link").href ?? "");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const url = href.trim();
    const chain = editor.chain().focus().extendMarkRange("link");
    if (!url) chain.unsetLink().run();
    else if (editor.state.selection.empty && !editor.isActive("link"))
      chain
        .insertContent({ type: "text", text: url, marks: [{ type: "link", attrs: { href: url } }] })
        .run();
    else chain.setLink({ href: url }).run();
    onClose();
  };
  return (
    <form
      ref={ref}
      className="compose-link popover-surface"
      style={{ left: pos.x, top: pos.y }}
      onSubmit={submit}
    >
      <input
        className="compose-link__input"
        placeholder="Paste or type a link"
        aria-label="Link address"
        value={href}
        onChange={(e) => setHref(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        spellCheck={false}
      />
    </form>
  );
}
