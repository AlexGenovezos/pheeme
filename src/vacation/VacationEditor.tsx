import { type Editor as TipTap } from "@tiptap/react";
import { useCallback, useEffect, useRef } from "react";
import { EditorBody, EditorToolbar, useComposeEditor } from "../compose/Editor";
import { cx } from "../lib/utils";
import "../compose/compose.css";

/** What the editor reports for its document: its HTML, "" when empty (as `useComposeEditor` does). */
const EMPTY = "<p></p>";
const htmlOf = (editor: TipTap) => {
  const html = editor.getHTML();
  return html === EMPTY ? "" : html;
};

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
  // The editor rewrites Gmail's HTML in its own terms (dropping what it can't keep, adding a
  // paragraph after a list or quote). `loaded` is that rewrite, read from the editor once it has
  // shown `from`; an edit undone back to it reports Gmail's original, so no change is left to save.
  const loaded = useRef<{ from: string; shown: string } | null>(null);
  const latest = useRef({ onChange, original });
  useEffect(() => {
    latest.current = { onChange, original };
  }, [onChange, original]);
  const report = useCallback((next: string) => {
    const { onChange: changed, original: gmail } = latest.current;
    const base = loaded.current;
    changed(base && base.from === gmail && next === base.shown ? gmail : next);
  }, []);
  const editor = useComposeEditor(html, report, label);
  useEffect(() => {
    if (!editor) return;
    const apply = () => {
      const showsGmail = html === original;
      const target = showsGmail && loaded.current?.from === original ? loaded.current.shown : html;
      // Gmail's text arriving (or Discard) isn't an edit, so Undo can't bring back what it replaced.
      if (htmlOf(editor) !== target || (showsGmail && loaded.current?.from !== original)) {
        editor.chain().setMeta("addToHistory", false).setContent(html, { emitUpdate: false }).run();
        if (showsGmail) loaded.current = { from: original, shown: htmlOf(editor) };
      }
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
