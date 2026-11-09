// The verification code found in an email: a card above the conversation, a chip in the list, and Shift+C.
import { Copy } from "lucide-react";
import type { MouseEvent } from "react";
import { Button } from "../components/ui/Button";
import { Kbd } from "../components/ui/Kbd";
import { toast } from "../components/ui/Toast";
import { useKeybinding } from "../keyboard/useCommands";
import { useThreadStore } from "../store/threadStore";
import { useUiStore } from "../store/uiStore";
import { conversationCode } from "./verificationCode";

export const COPY_CODE_COMMAND = "conversation.copy-code";
export const COPY_CODE_SHORTCUT = "shift+c";

export function copyCode(code: string) {
  return navigator.clipboard.writeText(code).then(
    () => void toast({ title: `Copied ${code}` }),
    () => void toast({ title: "Couldn't copy the code", tone: "danger" }),
  );
}

/** Copy the code in the open conversation (the `conversation.copy-code` command). */
export function copyOpenConversationCode() {
  const key = useUiStore.getState().openThread;
  const detail = key ? useThreadStore.getState().details.get(key) : undefined;
  const found = detail ? conversationCode(detail.messages) : null;
  if (found) void copyCode(found.code);
  else toast({ title: "No verification code in this conversation" });
}

/** The code, one tile per character, and a copy button. */
export function CodeCard({ code }: { code: string }) {
  const shortcut = useKeybinding(COPY_CODE_COMMAND, COPY_CODE_SHORTCUT);
  return (
    <section className="code-card" aria-label="Verification code">
      <div className="code-card__body">
        <span className="code-card__label">Verification code</span>
        {/* One image to assistive tech: the tiles are hidden, and aria-label on a plain span is ignored. */}
        <span className="code-card__digits selectable" role="img" aria-label={code}>
          {[...code].map((char, i) =>
            char === "-" ? (
              <span key={i} className="code-card__dash" aria-hidden="true">
                –
              </span>
            ) : (
              <span key={i} className="code-card__digit" aria-hidden="true">
                {char}
              </span>
            ),
          )}
        </span>
      </div>
      <Button variant="primary" size="sm" icon={<Copy />} onClick={() => void copyCode(code)}>
        Copy code
        {shortcut && <Kbd shortcut={shortcut} className="code-card__kbd" />}
      </Button>
    </section>
  );
}

/** The code in a conversation row: clicking copies it without opening the conversation. */
export function CodeChip({ code }: { code: string }) {
  const copy = (e: MouseEvent) => {
    e.stopPropagation();
    void copyCode(code);
  };
  return (
    <button
      type="button"
      className="code-chip"
      title="Copy verification code"
      aria-label={`Copy verification code ${code}`}
      // Mouse target only: focus stays on the listbox, and Shift+C is the keyboard path. Hidden from
      // assistive tech too: a listbox option can't contain controls.
      tabIndex={-1}
      aria-hidden="true"
      onMouseDown={(e) => e.preventDefault()}
      onClick={copy}
    >
      {code}
      <Copy aria-hidden="true" />
    </button>
  );
}
