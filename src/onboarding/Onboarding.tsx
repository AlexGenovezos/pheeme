import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { type AccountInfo, type ClientChoice } from "../lib/tauri";
import { ReceiveCredentials } from "../transfer/ReceiveCredentials";
import { clearProgress, loadProgress, saveProgress } from "./progress";
import { type StepId, STEPS, isStepId, stepById, stepIndex } from "./steps";
import { useSignIn } from "./useSignIn";
import { type SetupView, currentView } from "./view";
import { ChooseClient } from "./views/ChooseClient";
import { Credentials } from "./views/Credentials";
import { Done } from "./views/Done";
import { GuidePage } from "./views/GuidePage";
import { Intro } from "./views/Intro";
import { Rail } from "./views/Rail";
import { SignInError } from "./views/SignInError";
import { Waiting } from "./views/Waiting";
import "./onboarding.css";
import "../components/ui/Surface.css";

interface Props {
  /** Accounts already connected. Empty means first run: the full setup guide. */
  accounts: AccountInfo[];
  onConnected: (account: AccountInfo) => void;
  /** Leave without adding an account (only offered when one already exists). */
  onClose?: () => void;
  /** Sign this connected account in again (straight to Google) instead of adding one. */
  reconnect?: AccountInfo;
  /** Open at the first setup step with the step list (Settings › About › Open guide). */
  tutorial?: boolean;
}

export function Onboarding({ accounts, onConnected, onClose, reconnect, tutorial }: Props) {
  const firstRun = accounts.length === 0;
  const [initial] = useState(() =>
    firstRun
      ? loadProgress()
      : { step: tutorial ? STEPS[0].id : ("choose" as SetupView), clientId: "" },
  );
  const [setupView, setView] = useState<SetupView>(initial.step);
  const [guide, setGuide] = useState(firstRun || tutorial === true);
  const [clientId, setClientId] = useState(initial.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [preparedClient, setPreparedClient] = useState<ClientChoice | null>(null);
  const { state, start: startSignIn, cancel } = useSignIn();
  const view = currentView(state, setupView);
  const choice =
    state.phase === "authorizing" || state.phase === "failed" ? state.client : preparedClient;
  const error = state.phase === "failed" ? state.error : null;
  const authUrl = state.phase === "authorizing" ? state.authUrl : "";
  const connected = state.phase === "connected" ? state.account : null;

  useEffect(() => {
    if (firstRun && (view === "intro" || isStepId(view))) {
      saveProgress({ step: view, clientId });
    }
  }, [firstRun, view, clientId]);

  useEffect(() => {
    if (firstRun && state.phase === "connected") clearProgress();
  }, [firstRun, state.phase]);

  // In the dialog, a new step replaces the focused button: keep focus (and Escape, Tab) inside it.
  const pageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = pageRef.current?.closest<HTMLElement>('[role="dialog"]');
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus();
  }, [view]);

  const reconnectId = reconnect?.id;
  useEffect(() => {
    if (reconnectId) void startSignIn({ kind: "reconnect", accountId: reconnectId });
    // oxlint-disable-next-line react/exhaustive-deps -- start once per reconnect
  }, [reconnectId]);

  function cancelSignIn() {
    if (reconnect) {
      cancel();
      onClose?.();
      return;
    }
    cancel();
    setView(
      view === "receiving" || !choice
        ? "receive"
        : choice.kind === "sameAs"
          ? "choose"
          : "credentials",
    );
  }

  function goTo(step: StepId) {
    cancel();
    setGuide(true);
    setView(step);
  }

  function receive() {
    cancel();
    setGuide(false);
    setView("receive");
  }

  if (view === "intro") {
    return (
      <div className="onboarding onboarding--single">
        <Intro onStart={() => setView(STEPS[0].id)} onReceive={receive} />
      </div>
    );
  }

  // The guide's own pages: every step but the two with views of their own.
  const guideView = isStepId(view) && view !== "credentials" && view !== "authorize" ? view : null;
  const showRail = guide && view !== "choose" && view !== "receive" && view !== "receiving";

  const page = (
    <div ref={pageRef} className={`onboarding${showRail ? "" : " onboarding--single"}`}>
      {showRail && <Rail current={view} onSelect={goTo} />}
      <main className="onboarding-main">
        <div className="onboarding-content" key={view}>
          {view === "receive" && (
            <>
              <ReceiveCredentials
                onReceive={(invitation) => void startSignIn({ kind: "transfer", invitation })}
                onBack={() => {
                  cancel();
                  setGuide(firstRun);
                  setView(firstRun ? "intro" : "choose");
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
          {view === "choose" && !reconnect && (
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
                setPreparedClient({
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
              email={reconnect?.email}
              onCancel={cancelSignIn}
              onFixCredentials={choice?.kind === "new" ? cancelSignIn : undefined}
            />
          )}
          {view === "error" && error && (
            <SignInError
              error={error}
              onRetry={choice ? () => void startSignIn(choice) : undefined}
              onFixCredentials={
                choice?.kind === "new"
                  ? () => {
                      cancel();
                      setView("credentials");
                    }
                  : undefined
              }
            />
          )}
          {view === "done" && connected && (
            <Done account={connected} onContinue={() => onConnected(connected)} />
          )}
          {guideView && (
            <GuidePage
              step={stepById(guideView)}
              primary={
                guideView === "unverified"
                  ? {
                      label: "Continue to Google",
                      onClick: () => choice && void startSignIn(choice),
                    }
                  : {
                      label: "Next",
                      onClick: () => setView(STEPS[stepIndex(guideView) + 1].id),
                    }
              }
              onBack={
                guideView === "unverified"
                  ? () => setView("credentials")
                  : guideView === STEPS[0].id
                    ? firstRun
                      ? () => setView("intro")
                      : undefined
                    : () => setView(STEPS[stepIndex(guideView) - 1].id)
              }
            />
          )}
          {["credentials", "choose"].includes(view) && !reconnect && (
            <Button variant="ghost" size="lg" onClick={receive}>
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
  if (!onClose) return page;

  // With an account already connected, setup is a dialog the size of Settings over the app, not
  // the whole window. Dismissing it once the account is in counts as continuing.
  return (
    <Modal
      title={reconnect ? "Sign in again" : tutorial ? "Setup guide" : "Add account"}
      titleId="onboarding-dialog-title"
      onClose={connected ? () => onConnected(connected) : onClose}
      className="onboarding-dialog"
      scrimClassName="settings-scrim dialog-scrim"
      titleClassName="onboarding-dialog__title"
    >
      {page}
    </Modal>
  );
}
