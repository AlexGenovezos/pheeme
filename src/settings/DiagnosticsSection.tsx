import { save } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { Button } from "../components/ui/Button";
import { Select } from "../components/ui/Select";
import { Switch } from "../components/ui/Switch";
import { TextInput } from "../components/ui/TextInput";
import { saveDiagnostics, sendDiagnostics, toCommandError } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { emailRequest, useEmailOnScreen } from "./emailOnScreen";
import { SettingsRow, SettingsSection } from "./rows";
import { TELEMETRY_DESCRIPTION, TELEMETRY_TITLE, TelemetrySwitch } from "./telemetry";

/** The Worker keeps notes to this length. */
export const NOTE_MAX_LENGTH = 2000;

type Status = { kind: "done" | "failed"; text: string } | null;

/**
 * Settings › About › Diagnostics: the anonymous usage ping switch, and sending a scrubbed log bundle to the developer (or
 * saving it to a file).
 */
export function DiagnosticsSection() {
  const accounts = useAccountStore((s) => s.accounts);
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState<"send" | "save" | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const onScreen = useEmailOnScreen();
  const [includeEmail, setIncludeEmail] = useState(false);
  // Read when Send is pressed, so the images are reported as they are then.
  const email = () => (includeEmail && onScreen ? emailRequest(onScreen.key) : undefined);

  // A picked account that was since removed falls back to the first.
  const account = accounts.find((a) => a.email === picked) ?? accounts[0];
  const replyTo = account ? account.email : typed.trim() || null;

  async function send() {
    setBusy("send");
    setStatus(null);
    try {
      await sendDiagnostics(note, replyTo, email());
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
      const included = email();
      const path = await save({
        defaultPath: "pheeme-diagnostics.zip",
        filters: [{ name: "Zip archive", extensions: ["zip"] }],
      });
      if (!path) return;
      await saveDiagnostics(note, replyTo, path, included);
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
      <div className="settings-diagnostics__sender settings-diagnostics__reply">
        <span>Sent as</span>
        <Select
          className="settings-diagnostics__select"
          aria-label="Reply address"
          value={account.email}
          options={accounts.map((a) => ({ value: a.email, label: a.email }))}
          onChange={setPicked}
        />
        <span>so the developer can reply</span>
      </div>
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
    <>
      <SettingsSection title="Usage stats">
        <SettingsRow
          title={TELEMETRY_TITLE}
          description={TELEMETRY_DESCRIPTION}
          control={<TelemetrySwitch />}
        />
      </SettingsSection>
      <SettingsSection title="Diagnostics">
        <SettingsRow
          title="Send diagnostics"
          description="Sends recent logs to the developer so they can see why something was slow or broken. Logs never include your emails, subjects or contacts. Your note is sent as you type it, and an email only if you include it."
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
          {onScreen && (
            <div className="settings-diagnostics__email">
              <Switch
                checked={includeEmail}
                onChange={setIncludeEmail}
                label="Include the email on screen"
              />
              <div className="settings-diagnostics__email-text">
                <span className="settings-diagnostics__label">Include the email on screen</span>
                <span className="settings-diagnostics__sender">
                  {`“${onScreen.subject || "(no subject)"}”: its text, sender and image addresses go to the developer too, so they can see why it looks wrong.`}
                </span>
              </div>
            </div>
          )}
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
    </>
  );
}
