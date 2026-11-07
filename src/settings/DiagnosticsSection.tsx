import { save } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { Button } from "../components/ui/Button";
import { TextInput } from "../components/ui/TextInput";
import { saveDiagnostics, sendDiagnostics, toCommandError } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { SettingsRow, SettingsSection } from "./rows";

/** The Worker keeps notes to this length. */
export const NOTE_MAX_LENGTH = 2000;

type Status = { kind: "done" | "failed"; text: string } | null;

/** Settings › Diagnostics: send a scrubbed log bundle to the developer, or save it to a file. */
export function DiagnosticsSection() {
  const accounts = useAccountStore((s) => s.accounts);
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState<"send" | "save" | null>(null);
  const [status, setStatus] = useState<Status>(null);

  // A picked account that was since removed falls back to the first.
  const account = accounts.find((a) => a.email === picked) ?? accounts[0];
  const replyTo = account ? account.email : typed.trim() || null;

  async function send() {
    setBusy("send");
    setStatus(null);
    try {
      await sendDiagnostics(note, replyTo);
      setStatus({ kind: "done", text: "Sent. Thanks, Alex will take a look." });
    } catch (raw) {
      setStatus({
        kind: "failed",
        text: `${toCommandError(raw).message} You can save the file and email it instead.`,
      });
    } finally {
      setBusy(null);
    }
  }

  async function saveCopy() {
    setBusy("save");
    setStatus(null);
    try {
      const path = await save({
        defaultPath: "pheeme-diagnostics.zip",
        filters: [{ name: "Zip archive", extensions: ["zip"] }],
      });
      if (!path) return;
      await saveDiagnostics(note, replyTo, path);
      setStatus({ kind: "done", text: `Saved to ${path}.` });
    } catch (raw) {
      setStatus({ kind: "failed", text: toCommandError(raw).message });
    } finally {
      setBusy(null);
    }
  }

  let sender;
  if (accounts.length === 1 && account) {
    sender = (
      <p className="settings-diagnostics__sender">{`Sent as ${account.email} so the developer can reply`}</p>
    );
  } else if (account) {
    sender = (
      <p className="settings-diagnostics__sender">
        Sent as{" "}
        <select
          className="settings-diagnostics__select"
          aria-label="Reply address"
          value={account.email}
          onChange={(e) => setPicked(e.target.value)}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.email}>
              {a.email}
            </option>
          ))}
        </select>{" "}
        so the developer can reply
      </p>
    );
  } else {
    sender = (
      <label className="settings-diagnostics__field">
        <span className="settings-diagnostics__label">Your email (so the developer can reply)</span>
        <TextInput
          type="email"
          value={typed}
          placeholder="Optional"
          onChange={(e) => setTyped(e.target.value)}
        />
      </label>
    );
  }

  return (
    <SettingsSection title="Diagnostics">
      <SettingsRow
        title="Send diagnostics"
        description="Sends recent logs to the developer so they can see why something was slow or broken. Logs never include your emails, subjects or contacts. Your note is sent as you type it."
      />
      <form
        className="settings-diagnostics"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label className="settings-diagnostics__field">
          <span className="settings-diagnostics__label">What happened?</span>
          <textarea
            className="settings-diagnostics__note"
            value={note}
            maxLength={NOTE_MAX_LENGTH}
            rows={3}
            placeholder="Optional"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        {sender}
        <div className="settings-diagnostics__actions">
          <Button type="submit" variant="primary" size="sm" disabled={busy !== null}>
            {busy === "send" ? "Sending…" : "Send"}
          </Button>
          <Button size="sm" disabled={busy !== null} onClick={() => void saveCopy()}>
            Save a copy…
          </Button>
        </div>
        {status && (
          <p
            className="settings-diagnostics__status"
            data-failed={status.kind === "failed" || undefined}
            role={status.kind === "failed" ? "alert" : "status"}
          >
            {status.text}
          </p>
        )}
      </form>
    </SettingsSection>
  );
}
