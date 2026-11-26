import { createDocument, type Editor as TipTap, getHTMLFromFragment } from "@tiptap/react";
import { useCallback, useEffect, useRef } from "react";
import { EditorBody, EditorToolbar, useComposeEditor } from "../compose/Editor";
import { cx } from "../lib/utils";
import "../compose/compose.css";

/** What the editor reports for a document: its HTML, "" when empty (as `useComposeEditor` does). */
const EMPTY = "<p></p>";
const shownHtml = (html: string) => (html === EMPTY ? "" : html);
/** `html` as the editor would show and report it: its own rewrite, without what it can't keep. */
const rendered = (editor: TipTap, html: string) =>
  shownHtml(getHTMLFromFragment(createDocument(html, editor.schema).content, editor.schema));

/**
 * The vacation message's editor in Settings › Vacation responder: the compose editor with Gmail's
 * format bar, as HTML. Lazy-loaded, like the compose editor. `html` is the form's message and
 * `original` Gmail's; either may change from outside (Gmail's answer arriving, Discard), which
 * replaces the text.
 */
export default function VacationEditor({
  html,
  original,
  label,
  disabled,
  onChange,
}: {
  html: string;
  original: string;
  label: string;
  disabled: boolean;
  onChange(html: string): void;
}) {
  // The editor rewrites Gmail's HTML in its own terms (and drops what it can't keep). An edit
  // undone back to that rewrite reports Gmail's original, so no change is left to save.
  const latest = useRef({ onChange, original });
  useEffect(() => {
    latest.current = { onChange, original };
  }, [onChange, original]);
  const report = useCallback((next: string, from?: TipTap) => {
    const { onChange: changed, original: gmail } = latest.current;
    changed(from && next === rendered(from, gmail) ? gmail : next);
  }, []);
  const editorRef = useRef<TipTap | null>(null);
  const editor = useComposeEditor(
    html,
    (next) => report(next, editorRef.current ?? undefined),
    label,
  );
  useEffect(() => {
    editorRef.current = editor;
    if (!editor) return;
    const apply = () => {
      const current = shownHtml(editor.getHTML());
      const target = html === original ? rendered(editor, original) : html;
      // Gmail's text arriving (or Discard) isn't an edit, so Undo can't bring back what it replaced.
      if (current !== target)
        editor.chain().setMeta("addToHistory", false).setContent(html, { emitUpdate: false }).run();
      editor.setEditable(!disabled, false);
    };
    // Its view exists only once it's mounted, which TipTap announces with `create`.
    if (editor.isInitialized) {
      apply();
      return;
    }
    editor.on("create", apply);
    return () => {
      editor.off("create", apply);
    };
  }, [editor, html, original, disabled]);
  return (
    <div className={cx("vacation-editor", disabled && "vacation-editor--disabled")}>
      <EditorBody editor={editor} focusSeq={0} />
      {/* Disabled (and inert, so Settings' Tab cycle skips it) with the text. */}
      <fieldset className="vacation-editor__tools" disabled={disabled} inert={disabled}>
        <EditorToolbar editor={editor} />
      </fieldset>
    </div>
  );
}
