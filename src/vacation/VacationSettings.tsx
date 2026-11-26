// Settings › Vacation responder: each account's Gmail vacation responder (out-of-office reply),
// read from Gmail when the page opens and saved straight back with Save, as on Gmail's own
// settings page. Every field is there from the first frame; while the responder is off (or
// still loading) they stay in place, disabled, and Last day waits for its switch.
import { lazy, Suspense, useEffect, useState } from "react";
import { Button } from "../components/ui/Button";
import { DateField } from "../components/ui/DateField";
import { Skeleton } from "../components/ui/Skeleton";
import { Switch } from "../components/ui/Switch";
import { TextInput } from "../components/ui/TextInput";
import { cx } from "../lib/utils";
import type { CommandError } from "../lib/tauri";
import { ReconnectButton } from "../onboarding/Reconnect";
import { accountSectionTitle, SettingsRow, SettingsSection } from "../settings/rows";
import { useAccountStore } from "../store/accountStore";
import { formOf, formProblem, responderOf, sameForm, type VacationForm } from "./form";
import { useVacation } from "./vacationStore";
import "./Vacation.css";

const VacationEditor = lazy(() => import("./VacationEditor"));

/** The empty form shown, disabled, until Gmail answers. */
const BLANK: VacationForm = formOf({
  enabled: false,
  subject: "",
  html: "",
  onlyContacts: false,
  onlyDomain: false,
  startMs: null,
  endMs: null,
  workspace: false,
});

function AccountVacation({
  accountId,
  email,
  title,
}: {
  accountId: string;
  email: string;
  title: string;
}) {
  const state = useVacation((s) => s.accounts[accountId]);
  const loaded = state?.value;
  const [draft, setDraft] = useState<VacationForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<CommandError | "saved" | null>(null);

  useEffect(() => {
    void useVacation.getState().refresh(accountId);
  }, [accountId]);

  const original = loaded ? formOf(loaded) : BLANK;
  const form = draft ?? original;
  const dirty = draft !== null && !sameForm(draft, original);
  const ready = loaded !== undefined && !saving;
  const fieldsOn = ready && form.enabled;
  const workspace = loaded?.workspace ?? false;
  const domain = email.split("@")[1] ?? "";
  const problem = formProblem(form);

  const edit = (change: Partial<VacationForm>) => {
    setDraft({ ...form, ...change });
    setResult(null);
  };
  const save = async () => {
    if (!loaded || problem) return;
    setSaving(true);
    const error = await useVacation.getState().save(accountId, responderOf(form, workspace));
    setSaving(false);
    setResult(error ?? "saved");
    if (!error) setDraft(null);
  };
  const discard = () => {
    setDraft(null);
    setResult(null);
  };

  // One status line under the fields, holding its place whatever it says.
  const readError = !loaded ? state?.error : undefined;
  let status: React.ReactNode;
  if (readError?.code === "missing_scope")
    status =
      "Pheeme can't see this account's Gmail settings. Sign in again and allow Pheeme to manage your basic mail settings.";
  else if (readError) status = `Couldn't read it from Gmail: ${readError.message}`;
  else if (!loaded) status = <Skeleton width="40%" />;
  else if (saving) status = "Saving to Gmail…";
  else if (problem && dirty) status = problem;
  else if (result === "saved") status = "Saved to Gmail.";
  else if (result) status = `Couldn't save it: ${result.message}`;
  else if (dirty) status = "Not saved yet.";
  else status = loaded.enabled ? "On in Gmail." : "Off in Gmail.";
  const failed =
    !!readError || (result !== null && result !== "saved") || (dirty && problem !== null);

  let actions;
  if (readError?.code === "missing_scope") actions = <ReconnectButton accountId={accountId} />;
  else if (readError)
    actions = (
      <Button size="sm" onClick={() => void useVacation.getState().refresh(accountId)}>
        Try again
      </Button>
    );
  else
    actions = (
      <>
        <Button size="sm" disabled={!dirty || saving} onClick={discard}>
          Discard
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!dirty || !ready || problem !== null}
          onClick={() => void save()}
        >
          Save
        </Button>
      </>
    );

  const off = (on: boolean) => cx(!on && "vacation-row--off");

  return (
    <SettingsSection title={title}>
      <SettingsRow
        title="Vacation responder"
        description="Gmail replies to mail that arrives while you're away, once to each sender every 4 days. Turn it on to set the days and the message."
        control={
          <Switch
            label={`Vacation responder for ${email}`}
            checked={form.enabled}
            disabled={!ready}
            onChange={(enabled) => edit({ enabled })}
          />
        }
      />
      <SettingsRow
        className={off(fieldsOn)}
        title="First day"
        control={
          <DateField
            aria-label="First day"
            value={form.firstDay}
            disabled={!fieldsOn}
            onChange={(firstDay) => edit({ firstDay })}
          />
        }
      />
      <SettingsRow
        className={off(fieldsOn)}
        title="Last day"
        description="Optional. Turn on to stop replying after this day."
        control={
          <>
            <Switch
              label="Has a last day"
              checked={form.ends}
              disabled={!fieldsOn}
              onChange={(ends) => edit({ ends })}
            />
            <DateField
              aria-label="Last day"
              value={form.ends ? form.lastDay : ""}
              placeholder="No last day"
              min={form.firstDay}
              disabled={!fieldsOn || !form.ends}
              onChange={(lastDay) => edit({ lastDay })}
            />
          </>
        }
      />
      <SettingsRow
        className={off(fieldsOn)}
        title="Subject"
        control={
          <TextInput
            className="vacation-subject"
            aria-label="Subject"
            placeholder="Re: their subject"
            value={form.subject}
            disabled={!fieldsOn}
            onChange={(e) => edit({ subject: e.target.value })}
          />
        }
      />
      <div className={cx("settings-row settings-row--stacked", off(fieldsOn))}>
        <div className="settings-row__text">
          <div className="settings-row__title">Message</div>
        </div>
        <Suspense fallback={<div className="vacation-editor" aria-hidden="true" />}>
          <VacationEditor
            html={form.html}
            label={`Vacation message for ${email}`}
            disabled={!fieldsOn}
            onChange={(html) => {
              // The editor reports its own text back when it loads; that's no edit.
              if (html !== form.html) edit({ html });
            }}
          />
        </Suspense>
      </div>
      <SettingsRow
        className={off(fieldsOn)}
        title="Only reply to people in my Contacts"
        control={
          <Switch
            label="Only reply to people in my Contacts"
            checked={form.onlyContacts}
            disabled={!fieldsOn}
            onChange={(onlyContacts) => edit({ onlyContacts })}
          />
        }
      />
      <SettingsRow
        className={off(fieldsOn && workspace)}
        title={`Only reply to people at ${domain}`}
        description={
          !loaded ? (
            <Skeleton width="50%" />
          ) : workspace ? (
            "Mail from outside your organization gets no reply."
          ) : (
            "Only for Google Workspace accounts."
          )
        }
        control={
          <Switch
            label={`Only reply to people at ${domain}`}
            checked={workspace && form.onlyDomain}
            disabled={!fieldsOn || !workspace}
            onChange={(onlyDomain) => edit({ onlyDomain })}
          />
        }
      />
      <SettingsRow
        className={cx("vacation-status", failed && "vacation-status--failed")}
        title={<span role="status">{status}</span>}
        control={actions}
      />
    </SettingsSection>
  );
}

export function VacationSettings() {
  const accounts = useAccountStore((s) => s.accounts);
  if (accounts.length === 0)
    return (
      <SettingsSection title="Vacation responder">
        <SettingsRow title="Connect an account to set its vacation responder" />
      </SettingsSection>
    );
  return (
    <>
      {accounts.map((a) => (
        <AccountVacation
          key={a.id}
          accountId={a.id}
          email={a.email}
          title={accountSectionTitle("Vacation responder", a.email, accounts.length)}
        />
      ))}
    </>
  );
}
