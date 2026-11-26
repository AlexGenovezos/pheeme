import { EditorContent, useEditor, type Editor as TipTap } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef } from "react";
import { FormatBar } from "./FormatBar";
import { FORMATTING } from "./formatting";
import { InlineImageNode } from "./InlineImageNode";
import { pastedFiles } from "./paste";
import { SignatureNode } from "./SignatureNode";

/** What TipTap gives back for an empty document; stored as "" so a blank message stays blank. */
const EMPTY = "<p></p>";

/** What the compose panel does for the editor: files pasted into it, and the images its text shows. */
export interface EditorFiles {
  /** Files pasted into the text (a screenshot, say). */
  paste(files: File[]): void;
  /** Where to read the image a `cid:` URL names. */
  image(contentId: string): Promise<string | null>;
}

/**
 * The message body's editor: rich text with Gmail's formatting (`formatting.ts`: fonts, sizes, colours, alignment,
 * indenting, quotes, lists, links) and pasted images, as HTML. The body (`EditorBody`) and its formatting bar
 * (`EditorToolbar`) render apart, so the bar can sit above the footer.
 */
export function useComposeEditor(
  initialHtml: string,
  onChange: (html: string) => void,
  label = "Message",
  files?: EditorFiles,
) {
  const changed = useRef(onChange);
  const handlers = useRef(files);
  useEffect(() => {
    changed.current = onChange;
    handlers.current = files;
  }, [onChange, files]);
  return useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        code: false,
        horizontalRule: false,
        link: { openOnClick: false, autolink: true, defaultProtocol: "https" },
      }),
      ...FORMATTING,
      SignatureNode,
      // `resolve` reads the ref when an image's node view asks, never during render.
      // oxlint-disable-next-line react/refs
      InlineImageNode.configure({
        resolve: (contentId) => handlers.current?.image(contentId) ?? Promise.resolve(null),
      }),
    ],
    content: initialHtml,
    editorProps: {
      attributes: { class: "compose-editor__content", "aria-label": label },
      // A paste of only files (a screenshot) goes to the panel, which puts images in the text and attaches the
      // rest; handled here so ProseMirror doesn't try to read it as text.
      handlePaste: (_view, event) => {
        const pasted = pastedFiles(event.clipboardData);
        if (pasted.length === 0) return false;
        handlers.current?.paste(pasted);
        return true;
      },
    },
    onUpdate: ({ editor: e }) => {
      const html = e.getHTML();
      changed.current(html === EMPTY ? "" : html);
    },
  });
}

/** Take the images whose `cid:` names one of `contentIds` out of the text (their files couldn't be staged). */
export function removeImages(editor: TipTap, contentIds: string[]) {
  const srcs = new Set(contentIds.map((id) => `cid:${id}`));
  editor.commands.command(({ tr, state }) => {
    const found: Array<{ from: number; to: number }> = [];
    state.doc.descendants((node, pos) => {
      if (node.type.name === "inlineImage" && srcs.has(String(node.attrs.src)))
        found.push({ from: pos, to: pos + node.nodeSize });
    });
    for (const { from, to } of found.reverse()) tr.delete(from, to);
    // Not an edit to undo: undoing it would bring back an image that has no file.
    tr.setMeta("addToHistory", false);
    return found.length > 0;
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

export function EditorBody({
  editor,
  focusSeq,
  inert,
}: {
  editor: TipTap | null;
  focusSeq: number;
  inert?: boolean;
}) {
  useEffect(() => {
    if (!inert && focusSeq > 0) editor?.commands.focus("start");
  }, [editor, focusSeq, inert]);
  return <EditorContent editor={editor} className="compose-editor" inert={inert} />;
}

export function EditorToolbar({ editor }: { editor: TipTap | null }) {
  return editor ? <FormatBar editor={editor} /> : null;
}
