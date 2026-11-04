import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/Button";
import { TextInput } from "../components/ui/TextInput";
import {
  type AccountInfo,
  type ClientChoice,
  type CommandError,
  beginOauth,
  cancelOauth,
  completeOauth,
  openExternal,
  toCommandError,
} from "../lib/tauri";
import { parseClientJson } from "./clientJson";
import { clearProgress, loadProgress, saveProgress } from "./progress";
import { type GuideStep, STEPS, type StepId, stepById, stepIndex } from "./steps";
import { BROWSER_PROBLEMS, isCredentialProblem, problemTitle } from "./troubleshooting";
import { cancelClientTransfer, receiveClientTransfer } from "../transfer/api";
import { ReceiveCredentials } from "../transfer/ReceiveCredentials";
import "./onboarding.css";

type View = StepId | "choose" | "error" | "done" | "receive" | "receiving";

type SignInChoice = ClientChoice | { kind: "transfer"; invitation: string };

interface Props {
  /** Accounts already connected. Empty means first run: the full setup guide. */
  accounts: AccountInfo[];
  onConnected: (account: AccountInfo) => void;
  /** Leave without adding an account (only offered when one already exists). */
  onClose?: () => void;
}

const CLIENT_ID_SUFFIX = ".apps.googleusercontent.com";

export function Onboarding({ accounts, onConnected, onClose }: Props) {
  const firstRun = accounts.length === 0;
  const [initial] = useState(() =>
    firstRun ? loadProgress() : { step: "choose" as View, clientId: "" },
  );
  const [view, setView] = useState<View>(initial.step);
  const [guide, setGuide] = useState(firstRun);
  const [clientId, setClientId] = useState(initial.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [choice, setChoice] = useState<ClientChoice | null>(null);
  const [authUrl, setAuthUrl] = useState("");
  const [error, setError] = useState<CommandError | null>(null);
  const [connected, setConnected] = useState<AccountInfo | null>(null);
  const flowRef = useRef<string | null>(null);
  const transferRef = useRef<string | null>(null);
  // Bumped on every start, cancel and unmount, so a late response from an
  // abandoned attempt (e.g. begin_oauth stuck behind a keychain prompt) is ignored.
  const attemptRef = useRef(0);

  useEffect(() => {
    if (
      firstRun &&
      view !== "choose" &&
      view !== "error" &&
      view !== "done" &&
      view !== "receive" &&
      view !== "receiving"
    ) {
      saveProgress({ step: view, clientId });
    }
  }, [firstRun, view, clientId]);

  function abandonAttempt() {
    attemptRef.current += 1;
    const flowId = flowRef.current;
    flowRef.current = null;
    if (flowId) void cancelOauth(flowId).catch(() => {});
    const transferId = transferRef.current;
    transferRef.current = null;
    if (transferId) void cancelClientTransfer(transferId).catch(() => {});
  }

  // Leaving the screen mid-sign-in stops the backend from waiting for the browser.
  useEffect(() => abandonAttempt, []);

  async function startSignIn(next: SignInChoice) {
    abandonAttempt();
    const attempt = attemptRef.current;
    const current = () => attemptRef.current === attempt;
    // Do not retain the invitation in React state after starting the connection.
    setChoice(next.kind === "transfer" ? null : next);
    setError(null);
    setAuthUrl("");
    setView(next.kind === "transfer" ? "receiving" : "authorize");
    try {
      let start;
      if (next.kind === "transfer") {
        const transferId = crypto.randomUUID();
        transferRef.current = transferId;
        const pending = receiveClientTransfer(transferId, next.invitation);
        next.invitation = "";
        start = await pending;
        if (current()) transferRef.current = null;
      } else {
        start = await beginOauth(next);
      }
      if (!current()) {
        void cancelOauth(start.flowId).catch(() => {});
        return;
      }
      flowRef.current = start.flowId;
      setView("authorize");
      setAuthUrl(start.authUrl);
      void openExternal(start.authUrl).catch(() => {});
      const account = await completeOauth(start.flowId);
      if (!current()) return;
      flowRef.current = null;
      if (firstRun) clearProgress();
      setConnected(account);
      setView("done");
    } catch (raw) {
      // A cancelled or superseded attempt already moved the screen on.
      if (!current()) return;
      flowRef.current = null;
      setError(toCommandError(raw));
      if (next.kind === "transfer") {
        setView("receive");
        return;
      }
      setView("error");
    }
  }

  function cancelSignIn() {
    abandonAttempt();
    setView(
      view === "receiving" || !choice
        ? "receive"
        : choice.kind === "sameAs"
          ? "choose"
          : "credentials",
    );
  }

  function goTo(step: StepId) {
    setGuide(true);
    setView(step);
  }

  const showRail = guide && view !== "choose" && view !== "receive" && view !== "receiving";

  return (
    <div className={`onboarding${showRail ? "" : " onboarding--single"}`}>
      {showRail && <Rail current={view} onSelect={goTo} />}
      <main className="onboarding-main">
        <div className="onboarding-content" key={view}>
          {view === "receive" && (
            <>
              <ReceiveCredentials
                onReceive={(invitation) => void startSignIn({ kind: "transfer", invitation })}
                onBack={() => {
                  setError(null);
                  setGuide(firstRun);
                  setView(firstRun ? "welcome" : "choose");
                }}
              />
              {error && <p role="alert">{error.message}</p>}
            </>
          )}
          {view === "receiving" && (
            <>
              <h1>Waiting for the sending device</h1>
              <p className="guide-lead">
                Approve the transfer in Pheeme on your other device. This connection expires after
                five minutes.
              </p>
              <Button onClick={cancelSignIn}>Cancel transfer</Button>
            </>
          )}
          {view === "choose" && (
            <ChooseClient
              accounts={accounts}
              onReuse={(accountId) => void startSignIn({ kind: "sameAs", accountId })}
              onNew={() => setView("credentials")}
            />
          )}
          {view === "credentials" && (
            <Credentials
              clientId={clientId}
              clientSecret={clientSecret}
              onChange={(id, secret) => {
                setClientId(id);
                setClientSecret(secret);
              }}
              onSubmit={() => {
                setChoice({
                  kind: "new",
                  clientId: clientId.trim(),
                  clientSecret: clientSecret.trim(),
                });
                setView("unverified");
              }}
              onGuide={guide ? undefined : () => goTo("project")}
              onBack={
                guide
                  ? () => setView("client")
                  : accounts.length > 0
                    ? () => setView("choose")
                    : undefined
              }
            />
          )}
          {view === "authorize" && (
            <Waiting
              authUrl={authUrl}
              onCancel={cancelSignIn}
              onFixCredentials={choice?.kind === "new" ? cancelSignIn : undefined}
            />
          )}
          {view === "error" && error && (
            <SignInError
              error={error}
              onRetry={choice ? () => void startSignIn(choice) : undefined}
              onFixCredentials={choice?.kind === "new" ? () => setView("credentials") : undefined}
            />
          )}
          {view === "done" && connected && (
            <Done account={connected} onContinue={() => onConnected(connected)} />
          )}
          {stepIndex(view as StepId) !== -1 && !["credentials", "authorize"].includes(view) && (
            <GuidePage
              step={stepById(view as StepId)}
              primary={
                view === "unverified"
                  ? {
                      label: "Continue to Google",
                      onClick: () => choice && void startSignIn(choice),
                    }
                  : {
                      label: view === "welcome" ? "Get started" : "Next",
                      onClick: () => setView(STEPS[stepIndex(view as StepId) + 1].id),
                    }
              }
              onBack={
                view === "welcome"
                  ? undefined
                  : () =>
                      setView(
                        view === "unverified"
                          ? "credentials"
                          : STEPS[stepIndex(view as StepId) - 1].id,
                      )
              }
            />
          )}
          {["welcome", "credentials", "choose"].includes(view) && (
            <Button
              variant="ghost"
              size="lg"
              onClick={() => {
                setError(null);
                setGuide(false);
                setView("receive");
              }}
            >
              Receive from another device
            </Button>
          )}
        </div>
        {onClose && view !== "done" && (
          <Button variant="ghost" size="lg" className="onboarding-close" onClick={onClose}>
            Cancel
          </Button>
        )}
      </main>
    </div>
  );
}

function Rail({ current, onSelect }: { current: View; onSelect: (step: StepId) => void }) {
  const currentIndex = current === "error" ? stepIndex("authorize") : stepIndex(current as StepId);
  return (
    <nav className="onboarding-rail" aria-label="Setup steps">
      <div className="onboarding-rail__brand">Pheeme</div>
      <ol>
        {STEPS.map((step, index) => {
          const state =
            current === "done" || index < currentIndex
              ? "done"
              : index === currentIndex
                ? "current"
                : "todo";
          // Only steps already reached are clickable: the guide is meant to be followed in order.
          // Not while a sign-in is waiting on the browser or finished.
          const reachable =
            state === "done" && !["authorize", "done"].includes(current) && step.id !== "authorize";
          return (
            <li key={step.id} className={`rail-step rail-step--${state}`}>
              <button
                type="button"
                disabled={!reachable}
                aria-current={state === "current" ? "step" : undefined}
                onClick={() => onSelect(step.id)}
              >
                <span className="rail-step__dot" aria-hidden>
                  {state === "done" ? "✓" : index + 1}
                </span>
                {step.short}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function GuidePage({
  step,
  primary,
  onBack,
}: {
  step: GuideStep;
  primary: { label: string; onClick: () => void };
  onBack?: () => void;
}) {
  const numbered = step.id !== "welcome" && step.id !== "unverified";
  return (
    <>
      {step.id === "welcome" && <img className="onboarding-mark" src="/pheeme-mark.svg" alt="" />}
      <h1>{step.title}</h1>
      {numbered ? (
        <ol className="guide-actions">
          {step.actions.map((action) => (
            <li key={action}>{action}</li>
          ))}
        </ol>
      ) : (
        step.actions.map((action) => (
          <p key={action} className="guide-lead">
            {action}
          </p>
        ))
      )}
      {step.link && <ExternalButton label={step.link.label} url={step.link.url} primary />}
      {step.copy && (
        <div className="copy-list">
          {step.copy.map((item) => (
            <CopyField key={item.label} {...item} />
          ))}
        </div>
      )}
      {step.screenshot && <img className="guide-shot" src={step.screenshot} alt="" />}
      {step.why && (
        <p className="guide-why">
          <strong>Why: </strong>
          {step.why}
        </p>
      )}
      <Footer onBack={onBack} primary={primary} />
    </>
  );
}

function Footer({
  onBack,
  primary,
}: {
  onBack?: () => void;
  primary: { label: string; onClick: () => void; disabled?: boolean; submit?: boolean };
}) {
  return (
    <div className="onboarding-footer">
      {onBack ? (
        <Button variant="ghost" size="lg" onClick={onBack}>
          Back
        </Button>
      ) : (
        <span />
      )}
      <Button
        type={primary.submit ? "submit" : "button"}
        variant="primary"
        size="lg"
        disabled={primary.disabled}
        onClick={primary.submit ? undefined : primary.onClick}
      >
        {primary.label}
      </Button>
    </div>
  );
}

function useFlash(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return [
    on,
    () => {
      setOn(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setOn(false), 1500);
    },
  ];
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, flash] = useFlash();
  return (
    <div className="copy-field">
      <span className="copy-field__label">{label}</span>
      <code className="copy-field__value">{value}</code>
      <Button
        size="sm"
        onClick={() => void navigator.clipboard.writeText(value).then(flash, () => {})}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function ExternalButton({
  label,
  url,
  primary,
}: {
  label: string;
  url: string;
  primary?: boolean;
}) {
  const [failed, flash] = useFlash();
  return (
    <Button
      variant={primary ? "primary" : "secondary"}
      size={primary ? "lg" : "sm"}
      className="external"
      onClick={() =>
        void openExternal(url).catch(() => {
          // No browser could be opened: hand the user the link instead.
          void navigator.clipboard.writeText(url).catch(() => {});
          flash();
        })
      }
    >
      {failed ? "Link copied: paste it in your browser" : `${label} ↗`}
    </Button>
  );
}

function Credentials({
  clientId,
  clientSecret,
  onChange,
  onSubmit,
  onGuide,
  onBack,
}: {
  clientId: string;
  clientSecret: string;
  onChange: (clientId: string, clientSecret: string) => void;
  onSubmit: () => void;
  onGuide?: () => void;
  onBack?: () => void;
}) {
  const [jsonError, setJsonError] = useState("");
  const id = clientId.trim();
  const idProblem =
    id && !id.endsWith(CLIENT_ID_SUFFIX) ? `A client ID ends in ${CLIENT_ID_SUFFIX}.` : "";
  const ready = id.endsWith(CLIENT_ID_SUFFIX) && clientSecret.trim() !== "";

  function onIdInput(text: string) {
    const parsed = parseClientJson(text);
    if (parsed === null) {
      setJsonError("");
      onChange(text, clientSecret);
    } else if (parsed.ok) {
      setJsonError("");
      onChange(parsed.clientId, parsed.clientSecret);
    } else {
      setJsonError(parsed.reason);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onSubmit();
      }}
    >
      <h1>Paste your client ID and secret</h1>
      <p className="guide-lead">
        Copy both from the dialog Google showed when you created the Desktop app client. You can
        also paste the downloaded JSON file's contents into the first box.
      </p>
      <div className="field">
        <label htmlFor="client-id">Client ID</label>
        <TextInput
          id="client-id"
          size="lg"
          value={clientId}
          onChange={(event) => onIdInput(event.target.value)}
          placeholder={`1234-abcd${CLIENT_ID_SUFFIX}`}
          autoFocus
          invalid={Boolean(idProblem || jsonError)}
        />
        {(jsonError || idProblem) && (
          <small className="field__error">{jsonError || idProblem}</small>
        )}
      </div>
      <div className="field">
        <label htmlFor="client-secret">Client secret</label>
        <TextInput
          id="client-secret"
          size="lg"
          type="password"
          value={clientSecret}
          onChange={(event) => onChange(clientId, event.target.value)}
        />
        <small className="field__hint">
          Stored in your system keychain, never in Pheeme's database.
        </small>
      </div>
      {onGuide && (
        <p className="guide-why">
          No client yet?{" "}
          <button type="button" className="link" onClick={onGuide}>
            Follow the setup guide
          </button>
        </p>
      )}
      <Footer
        onBack={onBack}
        primary={{ label: "Next", onClick: onSubmit, disabled: !ready, submit: true }}
      />
    </form>
  );
}

function ChooseClient({
  accounts,
  onReuse,
  onNew,
}: {
  accounts: AccountInfo[];
  onReuse: (accountId: string) => void;
  onNew: () => void;
}) {
  // One option per distinct OAuth client, labelled by the first account using it.
  const byClient = new Map<string, AccountInfo>();
  for (const account of accounts)
    if (!byClient.has(account.clientId)) byClient.set(account.clientId, account);
  return (
    <>
      <h1>Add an account</h1>
      <p className="guide-lead">
        Another Google account can sign in through the Google Cloud app you already set up. A work
        account whose administrator requires its own OAuth client needs a different one.
      </p>
      <div className="choice-list">
        {[...byClient.values()].map((account) => (
          <button
            key={account.clientId}
            type="button"
            className="choice"
            onClick={() => onReuse(account.id)}
          >
            <strong>Use the same Google Cloud app</strong>
            <span>The one {account.email} signed in with</span>
          </button>
        ))}
        <button type="button" className="choice" onClick={onNew}>
          <strong>Use a different OAuth client</strong>
          <span>Paste another client ID and secret</span>
        </button>
      </div>
    </>
  );
}

function Waiting({
  authUrl,
  onCancel,
  onFixCredentials,
}: {
  authUrl: string;
  onCancel: () => void;
  onFixCredentials?: () => void;
}) {
  const [copied, flash] = useFlash();
  return (
    <>
      <div className="waiting-mark" aria-hidden />
      <h1>Finish signing in in your browser</h1>
      <p className="guide-lead">
        Pheeme opened Google's sign-in page. When it says you can close the tab, come back here.
      </p>
      <div className="button-row">
        <Button
          size="lg"
          disabled={!authUrl}
          onClick={() => void openExternal(authUrl).catch(() => {})}
        >
          Open the browser again
        </Button>
        <Button
          size="lg"
          disabled={!authUrl}
          onClick={() => void navigator.clipboard.writeText(authUrl).then(flash, () => {})}
        >
          {copied ? "Copied" : "Copy sign-in link"}
        </Button>
        <Button variant="ghost" size="lg" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <details className="problems">
        <summary>Seeing an error from Google in the browser?</summary>
        <ul>
          {BROWSER_PROBLEMS.map((problem) => (
            <li key={problem.code}>
              <strong>{problem.title}</strong>
              <p>{problem.fix}</p>
              <div className="button-row">
                {problem.link && (
                  <ExternalButton label={problem.link.label} url={problem.link.url} />
                )}
                {problem.action === "credentials" && onFixCredentials && (
                  <Button size="sm" onClick={onFixCredentials}>
                    Change client ID or secret
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

function SignInError({
  error,
  onRetry,
  onFixCredentials,
}: {
  error: CommandError;
  onRetry?: () => void;
  onFixCredentials?: () => void;
}) {
  const credentialsFirst = isCredentialProblem(error.code) && onFixCredentials;
  return (
    <div role="alert">
      <h1>{problemTitle(error.code)}</h1>
      <p className="guide-lead">{error.message}</p>
      <div className="onboarding-footer">
        {credentialsFirst ? (
          <>
            {onRetry ? (
              <Button variant="ghost" size="lg" onClick={onRetry}>
                Try again
              </Button>
            ) : (
              <span />
            )}
            <Button variant="primary" size="lg" onClick={onFixCredentials}>
              Change client ID or secret
            </Button>
          </>
        ) : (
          <>
            {onFixCredentials ? (
              <Button variant="ghost" size="lg" onClick={onFixCredentials}>
                Change client ID or secret
              </Button>
            ) : (
              <span />
            )}
            {onRetry && (
              <Button variant="primary" size="lg" onClick={onRetry}>
                Try again
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Done({ account, onContinue }: { account: AccountInfo; onContinue: () => void }) {
  return (
    <>
      <div className="done-mark" aria-hidden>
        ✓
      </div>
      <h1>{account.email} is connected</h1>
      <p className="guide-lead">
        Pheeme can now reach this account. You can add more accounts at any time.
      </p>
      <Footer primary={{ label: "Continue", onClick: onContinue }} />
    </>
  );
}
