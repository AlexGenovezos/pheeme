import { EditorBody, EditorToolbar, useComposeEditor } from "./Editor";
import "./compose.css";

/** The editor for an account's own signature in Settings › Signatures. Lazy-loaded, like the compose editor. */
export default function SignatureEditor({
  html,
  label,
  onChange,
}: {
  html: string;
  label: string;
  onChange(html: string): void;
}) {
  const editor = useComposeEditor(html, onChange, label);
  return (
    <div className="signature-editor">
      <EditorBody editor={editor} focusSeq={0} />
      <EditorToolbar editor={editor} />
    </div>
  );
}
