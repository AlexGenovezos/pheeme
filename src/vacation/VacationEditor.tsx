import { useCallback, useEffect, useRef } from "react";
import { EditorBody, EditorToolbar, useComposeEditor } from "../compose/Editor";
import { cx } from "../lib/utils";
import "../compose/compose.css";

/**
 * The vacation message's editor in Settings › Vacation responder: the compose editor with Gmail's
 * format bar, as HTML. Lazy-loaded, like the compose editor. `html` may change from outside
 * (Gmail's answer arriving, Discard), which replaces the text.
 */
export default function VacationEditor({
  html,
  label,
  disabled,
  onChange,
}: {
  html: string;
  label: string;
  disabled: boolean;
  onChange(html: string): void;
}) {
  // The editor rewrites Gmail's HTML in its own terms (and drops what it can't keep). When an edit
  // is undone back to that rewrite, report Gmail's original, so no change is left to save.
  const loaded = useRef({ shown: "", from: "" });
  const changed = useRef(onChange);
  useEffect(() => {
    changed.current = onChange;
  }, [onChange]);
  const report = useCallback((next: string) => {
    changed.current(next === loaded.current.shown ? loaded.current.from : next);
  }, []);
  const editor = useComposeEditor(html, report, label);
  useEffect(() => {
    if (!editor) return;
    const apply = () => {
      const current = editor.isEmpty ? "" : editor.getHTML();
      const showing =
        current === html || (html === loaded.current.from && current === loaded.current.shown);
      // Gmail's text arriving (or Discard) isn't an edit, so Undo can't bring back what it replaced.
      if (!showing) {
        editor.chain().setMeta("addToHistory", false).setContent(html, { emitUpdate: false }).run();
        loaded.current = { shown: editor.isEmpty ? "" : editor.getHTML(), from: html };
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
  }, [editor, html, disabled]);
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
