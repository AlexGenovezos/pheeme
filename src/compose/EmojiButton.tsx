import type { Editor as TipTap } from "@tiptap/react";
import { Smile } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import { IconButton } from "../components/ui/IconButton";
import { aboveOf, Floating } from "./floating";

const EmojiPicker = lazy(() => import("./EmojiPicker"));

/** Insert emoji, in the compose footer as in Gmail: opens the picker above it, which puts emoji at the cursor. */
export function EmojiButton({ editor, disabled }: { editor: TipTap | null; disabled?: boolean }) {
  const button = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <IconButton
        ref={button}
        label="Insert emoji"
        icon={<Smile />}
        aria-haspopup="dialog"
        aria-expanded={!!at}
        disabled={disabled}
        // Keep the cursor where it is in the text: that's where the emoji goes.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setAt((open) => (open || !button.current ? null : aboveOf(button.current)))}
      />
      {at && editor && (
        <Suspense fallback={null}>
          <Floating>
            <EmojiPicker
              at={at}
              // Back to the text when it closes, to carry on typing.
              returnFocus={editor.view.dom}
              ignore={(target) => !!button.current?.contains(target)}
              onPick={(char) => editor.chain().insertContent(char).run()}
              onClose={() => setAt(null)}
            />
          </Floating>
        </Suspense>
      )}
    </>
  );
}
