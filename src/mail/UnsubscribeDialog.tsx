// "Unsubscribe from <sender>?", asked before anything is sent, as Gmail does. Shown over the app,
// whichever way it was asked for (the sender's link in the message, the More menu or the palette).
import { useId, useState } from "react";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { useStatsStore } from "../stats/statsStore";
import { type UnsubscribeRequest, unsubscribeFrom, useUnsubscribeStore } from "./unsubscribe";
import "../components/ui/Surface.css";
import "./unsubscribe.css";

const HOW: Record<UnsubscribeRequest["method"], string> = {
  one_click:
    "Pheeme will tell the sender to take you off their list. Some lists take a few days to stop.",
  link: "Pheeme will open the sender's unsubscribe page, where you finish unsubscribing.",
  email: "Pheeme will open a message to the sender. Send it to unsubscribe.",
};

export function UnsubscribeDialogHost() {
  const request = useUnsubscribeStore((s) => s.request);
  return request ? <UnsubscribeDialog key={request.messageId} request={request} /> : null;
}

function UnsubscribeDialog({ request }: { request: UnsubscribeRequest }) {
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const close = () => useUnsubscribeStore.setState({ request: null });
  const confirm = async () => {
    setBusy(true);
    const outcome = await unsubscribeFrom(request);
    // A message to send opens over everything: the Stats window would hide it.
    if (outcome === "email") useStatsStore.getState().close();
    close();
  };
  return (
    <Modal
      title={`Unsubscribe from ${request.who}?`}
      titleId={titleId}
      onClose={() => !busy && close()}
      scrimClassName="unsubscribe-scrim dialog-scrim"
      className="unsubscribe-dialog dialog-surface"
      titleClassName="unsubscribe-dialog__title"
    >
      <p className="unsubscribe-dialog__message">{HOW[request.method]}</p>
      <div className="unsubscribe-dialog__actions">
        <Button size="sm" variant="ghost" disabled={busy} onClick={close}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          data-autofocus=""
          onClick={() => void confirm()}
        >
          Unsubscribe
        </Button>
      </div>
    </Modal>
  );
}
