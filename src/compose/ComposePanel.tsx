import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import DOMPurify from "dompurify";
import { ChevronDown, Minus, MoreHorizontal, Paperclip, Trash2, X } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { describeShortcut } from "../keyboard/format";
import { showContextMenu } from "../lib/contextMenu";
import { suggestContacts } from "../lib/tauri";
import { cx } from "../lib/utils";
import { formatSize } from "../mail/AttachmentList";
import { HtmlBody } from "../mail/EmailBody";
import { useAccountStore } from "../store/accountStore";
import {
  attachmentBytes,
  AUTOSAVE_MS,
  type ComposeWindow,
  MAX_ATTACHMENT_BYTES,
  useComposeStore,
} from "./composeStore";
import { EditorBody, EditorToolbar, useComposeEditor } from "./Editor";
import { RecipientField } from "./RecipientField";

const SEND_SHORTCUT = "mod+enter";

const TITLES: Record<ComposeWindow["kind"], string> = {
  new: "New message",
  draft: "Draft",
  reply: "Reply",
  replyAll: "Reply all",
  forward: "Forward",
};

/** "Saving…" or "Draft saved", for the footer. */
function saveStatus(win: ComposeWindow): string {
  if (win.saving) return "Saving…";
  if (win.savedAt && win.version === win.savedVersion) return "Draft saved";
  return "";
}

/** One message being written: a panel docked to the bottom of the window. */
export function ComposePanel({ win }: { win: ComposeWindow }) {
  const store = useComposeStore.getState();
  const subject = win.draft.subject.trim();
  const title = win.minimized && subject ? subject : TITLES[win.kind];

  // The send prompt takes focus, so Escape and Enter reach it even from the editor's link input.
  const confirmSendRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (win.confirmingSend) confirmSendRef.current?.focus();
  }, [win.confirmingSend]);

  // Autosave while there's something new (minimized too).
  useEffect(() => {
    if (win.loading) return;
    const timer = setInterval(
      () => void useComposeStore.getState().save(win.id, { quiet: true }),
      AUTOSAVE_MS,
    );
    return () => clearInterval(timer);
  }, [win.id, win.loading]);

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (!win.confirmingSend) store.requestSend(win.id);
    } else if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      if (win.confirmingSend) store.cancelSend(win.id);
      else if (win.confirmingClose) store.cancelClose(win.id);
      else store.requestClose(win.id);
    }
  };

  if (win.minimized) {
    return (
      <section
        className="compose compose--minimized"
        aria-label={title}
        data-compose-id={win.id}
        data-owns-keys=""
      >
        <header className="compose__header">
          <button
            type="button"
            className="compose__title compose__title--button"
            onClick={() => store.setMinimized(win.id, false)}
          >
            {title}
          </button>
          <IconButton
            size="sm"
            label="Close"
            icon={<X />}
            onClick={() => store.requestClose(win.id)}
          />
        </header>
      </section>
    );
  }

  return (
    <section
      className="compose"
      aria-label={title}
      data-compose-id={win.id}
      data-owns-keys=""
      onKeyDown={onKeyDown}
    >
      <header className="compose__header">
        <span className="compose__title">{title}</span>
        <IconButton
          size="sm"
          label="Minimize"
          icon={<Minus />}
          onClick={() => store.setMinimized(win.id, true)}
        />
        <IconButton
          size="sm"
          label="Close"
          shortcut="escape"
          icon={<X />}
          onClick={() => store.requestClose(win.id)}
        />
      </header>

      {win.loading ? (
        <div className="compose__loading" aria-busy="true">
          <span className="compose__loading-text">Loading…</span>
        </div>
      ) : (
        <ComposeForm win={win} />
      )}

      {win.confirmingSend && (
        <div className="compose__confirm" role="alertdialog" aria-label="Send this message?">
          <p className="compose__confirm-title">Send this message?</p>
          <div className="compose__confirm-actions">
            <Button variant="ghost" onClick={() => store.cancelSend(win.id)}>
              Keep editing
            </Button>
            <Button ref={confirmSendRef} variant="primary" onClick={() => void store.send(win.id)}>
              Send
            </Button>
          </div>
        </div>
      )}

      {win.confirmingClose && (
        <div className="compose__confirm" role="alertdialog" aria-label="Save draft or discard?">
          <p className="compose__confirm-title">Save this message as a draft?</p>
          <div className="compose__confirm-actions">
            <Button variant="ghost" onClick={() => store.cancelClose(win.id)}>
              Keep editing
            </Button>
            <Button variant="danger" onClick={() => void store.discard(win.id)}>
              Discard
            </Button>
            <Button variant="primary" onClick={() => void store.saveAndClose(win.id)}>
              Save draft
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

/** The fields, body and footer. Mounted while the panel is open, so the editor starts from the saved body. */
function ComposeForm({ win }: { win: ComposeWindow }) {
  const store = useComposeStore.getState();
  const focusRequest = useComposeStore((s) =>
    s.focusRequest?.id === win.id ? s.focusRequest.seq : 0,
  );
  const accounts = useAccountStore((s) => s.accounts);
  const account = accounts.find((a) => a.id === win.accountId);
  const toRef = useRef<HTMLInputElement>(null);
  const suggest = useCallback(
    (query: string) => suggestContacts(win.accountId, query),
    [win.accountId],
  );
  const [showCc, setShowCc] = useState(win.draft.cc.length > 0);
  const [showBcc, setShowBcc] = useState(win.draft.bcc.length > 0);
  const [showQuote, setShowQuote] = useState(false);
  const [editorFocus, setEditorFocus] = useState(0);
  const { draft } = win;
  const editor = useComposeEditor(draft.bodyHtml, (bodyHtml) => store.update(win.id, { bodyHtml }));
  useEffect(() => {
    editor?.setEditable(!win.sending, false); // no update event: not an edit
  }, [editor, win.sending]);

  // Focus: replies start in the body, new messages in To.
  useEffect(() => {
    if (!focusRequest) return;
    if (win.kind === "new" && draft.to.length === 0) toRef.current?.focus();
    else setEditorFocus((n) => n + 1);
    // Only a new request moves focus, not every edit.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [focusRequest]);

  useEffect(() => {
    if (draft.cc.length > 0) setShowCc(true);
    if (draft.bcc.length > 0) setShowBcc(true);
  }, [draft.cc.length, draft.bcc.length]);

  const bytes = attachmentBytes(draft);
  const overLimit = bytes > MAX_ATTACHMENT_BYTES;

  const pickFiles = async () => {
    const picked = await openFileDialog({ multiple: true, directory: false }).catch(() => null);
    const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
    void store.attachFiles(win.id, paths);
  };

  const chooseAccount = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    void showContextMenu(
      accounts.map((a) => ({
        id: a.id,
        label: a.displayName ? `${a.displayName} <${a.email}>` : a.email,
        checked: a.id === win.accountId,
        onSelect: () => store.setAccount(win.id, a.id),
      })),
      { x: rect.left, y: rect.bottom },
    );
  };

  const quote = useMemo(
    () => (draft.quoteHtml ? DOMPurify.sanitize(draft.quoteHtml, { WHOLE_DOCUMENT: false }) : ""),
    [draft.quoteHtml],
  );

  const canSwitchAccount = win.kind === "new" && accounts.length > 1;
  return (
    <>
      <div className="compose__fields">
        <div className="compose-field">
          <span className="compose-field__label">From</span>
          {canSwitchAccount ? (
            <button type="button" className="compose-from" onClick={chooseAccount}>
              <span className="compose-from__text">{account?.email ?? "Choose account"}</span>
              <ChevronDown aria-hidden="true" />
            </button>
          ) : (
            <span className="compose-from compose-from--static">{account?.email}</span>
          )}
        </div>
        <RecipientField
          ref={toRef}
          label="To"
          value={draft.to}
          onChange={(to) => store.update(win.id, { to })}
          suggest={suggest}
          trailing={
            <span className="compose-field__toggles">
              {!showCc && (
                <button type="button" className="compose-toggle" onClick={() => setShowCc(true)}>
                  Cc
                </button>
              )}
              {!showBcc && (
                <button type="button" className="compose-toggle" onClick={() => setShowBcc(true)}>
                  Bcc
                </button>
              )}
            </span>
          }
        />
        {showCc && (
          <RecipientField
            label="Cc"
            value={draft.cc}
            onChange={(cc) => store.update(win.id, { cc })}
            suggest={suggest}
          />
        )}
        {showBcc && (
          <RecipientField
            label="Bcc"
            value={draft.bcc}
            onChange={(bcc) => store.update(win.id, { bcc })}
            suggest={suggest}
          />
        )}
        <div className="compose-field">
          <label className="compose-field__label" htmlFor={`subject-${win.id}`}>
            Subject
          </label>
          <input
            id={`subject-${win.id}`}
            className="compose-field__input"
            value={draft.subject}
            onChange={(e) => store.update(win.id, { subject: e.target.value })}
            autoComplete="off"
          />
        </div>
      </div>

      <div className="compose__body">
        <EditorBody editor={editor} focusSeq={editorFocus} />
        {quote && (
          <div className="compose-quote">
            <button
              type="button"
              className="compose-quote__toggle"
              aria-expanded={showQuote}
              aria-label={showQuote ? "Hide quoted text" : "Show quoted text"}
              title={showQuote ? "Hide quoted text" : "Show quoted text"}
              onClick={() => setShowQuote((v) => !v)}
            >
              <MoreHorizontal aria-hidden="true" />
            </button>
            {showQuote && <HtmlBody html={quote} declaresDark={false} />}
          </div>
        )}
        {(draft.attachments.length > 0 || win.attaching > 0) && (
          <ul className="compose-attachments" aria-label="Attachments">
            {draft.attachments.map((a) => (
              <li key={a.id} className="compose-attachment">
                <Paperclip aria-hidden="true" className="compose-attachment__icon" />
                <span className="compose-attachment__name" title={a.filename}>
                  {a.filename}
                </span>
                <span className="compose-attachment__size">{formatSize(a.size)}</span>
                <button
                  type="button"
                  className="compose-attachment__remove"
                  aria-label={`Remove ${a.filename}`}
                  onClick={() => store.removeAttachment(win.id, a.id)}
                >
                  <X aria-hidden="true" />
                </button>
              </li>
            ))}
            {win.attaching > 0 && (
              <li className="compose-attachment compose-attachment--pending">
                Attaching {win.attaching === 1 ? "a file" : `${win.attaching} files`}…
              </li>
            )}
          </ul>
        )}
      </div>

      <EditorToolbar editor={editor} />

      {win.error && (
        <p className="compose__error" role="alert">
          {win.error}
        </p>
      )}

      <footer className="compose__footer">
        <Button
          variant="primary"
          disabled={win.sending}
          onClick={() => store.requestSend(win.id)}
          title={`Send (${describeShortcut(SEND_SHORTCUT)})`}
        >
          {win.sending ? "Sending…" : "Send"}
        </Button>
        <IconButton label="Attach files" icon={<Paperclip />} onClick={() => void pickFiles()} />
        {bytes > 0 && (
          <span
            className={cx("compose__size", overLimit && "compose__size--over")}
            title="Gmail allows 25 MB of attachments per message"
          >
            {formatSize(bytes)} of 25 MB
          </span>
        )}
        <span className="compose__status" aria-live="polite">
          {saveStatus(win)}
        </span>
        <IconButton
          label="Discard draft"
          icon={<Trash2 />}
          onClick={() => void store.discard(win.id)}
        />
      </footer>
    </>
  );
}
