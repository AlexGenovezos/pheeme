import { EditorContent, useEditor, useEditorState, type Editor as TipTap } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Italic, Link2, List, ListOrdered, Underline } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { IconButton } from "../components/ui/IconButton";
import { cx } from "../lib/utils";
import { SignatureNode } from "./SignatureNode";

/** What TipTap gives back for an empty document; stored as "" so a blank message stays blank. */
const EMPTY = "<p></p>";

/**
 * The message body's editor: rich text with bold, italic, underline, lists and links, as HTML. The body
 * (`EditorBody`) and its formatting bar (`EditorToolbar`) render apart, so the bar can sit above the footer.
 */
export function useComposeEditor(
  initialHtml: string,
  onChange: (html: string) => void,
  label = "Message",
) {
  const changed = useRef(onChange);
  useEffect(() => {
    changed.current = onChange;
  }, [onChange]);
  return useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        code: false,
        horizontalRule: false,
        link: { openOnClick: false, autolink: true, defaultProtocol: "https" },
      }),
      SignatureNode,
    ],
    content: initialHtml,
    editorProps: { attributes: { class: "compose-editor__content", "aria-label": label } },
    onUpdate: ({ editor: e }) => {
      const html = e.getHTML();
      changed.current(html === EMPTY ? "" : html);
    },
  });
}

/** Put `html` in place of the body's signature (or after the body when it has none); `null` removes it. */
export function replaceSignature(editor: TipTap, html: string | null) {
  editor.commands.command(({ tr, state }) => {
    let at: { from: number; to: number } | null = null;
    state.doc.forEach((node, offset) => {
      if (!at && node.type.name === "signature") at = { from: offset, to: offset + node.nodeSize };
    });
    const range = at as { from: number; to: number } | null;
    const signature = html ? state.schema.nodes.signature.create({ html }) : null;
    if (range && signature) tr.replaceWith(range.from, range.to, signature);
    else if (range) tr.delete(range.from, range.to);
    else if (signature) tr.insert(state.doc.content.size, signature);
    return true;
  });
}

export function EditorBody({ editor, focusSeq }: { editor: TipTap | null; focusSeq: number }) {
  useEffect(() => {
    if (focusSeq > 0) editor?.commands.focus("start");
  }, [editor, focusSeq]);
  return <EditorContent editor={editor} className="compose-editor" />;
}

export function EditorToolbar({ editor }: { editor: TipTap | null }) {
  return editor ? <Toolbar editor={editor} /> : null;
}

function Toolbar({ editor }: { editor: TipTap }) {
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      link: e.isActive("link"),
    }),
  });
  const [linking, setLinking] = useState(false);
  const chain = () => editor.chain().focus();
  const button = (
    label: string,
    on: boolean,
    icon: React.ReactNode,
    run: () => void,
    shortcut?: string,
  ) => (
    <IconButton
      size="sm"
      label={label}
      shortcut={shortcut}
      icon={icon}
      aria-pressed={on}
      className={cx("compose-toolbar__button", on && "compose-toolbar__button--on")}
      onMouseDown={(e) => e.preventDefault()} // keep the selection in the editor
      onClick={run}
    />
  );

  return (
    <div className="compose-toolbar" role="toolbar" aria-label="Formatting">
      {button("Bold", active.bold, <Bold />, () => chain().toggleBold().run(), "mod+b")}
      {button("Italic", active.italic, <Italic />, () => chain().toggleItalic().run(), "mod+i")}
      {button(
        "Underline",
        active.underline,
        <Underline />,
        () => chain().toggleUnderline().run(),
        "mod+u",
      )}
      <span className="compose-toolbar__separator" />
      {button("Bulleted list", active.bullet, <List />, () => chain().toggleBulletList().run())}
      {button("Numbered list", active.ordered, <ListOrdered />, () =>
        chain().toggleOrderedList().run(),
      )}
      <span className="compose-toolbar__separator" />
      {button("Link", active.link || linking, <Link2 />, () => setLinking((v) => !v))}
      {linking && <LinkInput editor={editor} onDone={() => setLinking(false)} />}
    </div>
  );
}

/** Set or clear the link on the selection. `window.prompt` doesn't exist in every webview, so it's inline. */
function LinkInput({ editor, onDone }: { editor: TipTap; onDone(): void }) {
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
    onDone();
  };
  return (
    <form className="compose-link" onSubmit={submit}>
      <input
        className="compose-link__input"
        autoFocus
        placeholder="Paste or type a link"
        aria-label="Link address"
        value={href}
        onChange={(e) => setHref(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onDone();
            editor.commands.focus();
          }
        }}
        spellCheck={false}
      />
    </form>
  );
}
