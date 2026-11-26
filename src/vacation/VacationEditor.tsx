import { useEffect } from "react";
import { EditorBody, EditorToolbar, useComposeEditor } from "../compose/Editor";
import { cx } from "../lib/utils";
import "../compose/compose.css";

/**
 * The vacation message's editor in Settings › Vacation responder: the compose editor (bold,
 * italic, underline, lists, links), as HTML. Lazy-loaded, like the compose editor. `html` may
 * change from outside (Gmail's answer arriving, Discard), which replaces the text.
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
  const editor = useComposeEditor(html, onChange, label);
  useEffect(() => {
    if (!editor) return;
    const apply = () => {
      const current = editor.isEmpty ? "" : editor.getHTML();
      // Gmail's text arriving (or Discard) isn't an edit, so Undo can't bring back what it replaced.
      if (current !== html)
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
  }, [editor, html, disabled]);
  return (
    <div className={cx("vacation-editor", disabled && "vacation-editor--disabled")}>
      <EditorBody editor={editor} focusSeq={0} />
      {/* The fieldset disables the formatting buttons with the text. */}
      <fieldset className="vacation-editor__tools" disabled={disabled}>
        <EditorToolbar editor={editor} />
      </fieldset>
    </div>
  );
}
