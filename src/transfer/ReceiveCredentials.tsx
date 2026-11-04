import { useState } from "react";
import { Button } from "../components/ui/Button";
import { TextInput } from "../components/ui/TextInput";

export function ReceiveCredentials({
  onReceive,
  onBack,
}: {
  onReceive: (invitation: string) => void;
  onBack: () => void;
}) {
  const [invitation, setInvitation] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (invitation.trim()) {
          onReceive(invitation.trim());
          setInvitation("");
        }
      }}
    >
      <h1>Receive from another device</h1>
      <p className="guide-lead">
        Reuse the Google Cloud app you already set up. Connect both devices to the same Wi-Fi or
        Ethernet network.
      </p>
      <ol className="guide-actions">
        <li>On the other device, open Settings → Accounts.</li>
        <li>Choose Send to another device, then copy the transfer code below.</li>
      </ol>
      <div className="field">
        <label htmlFor="transfer-code">Transfer code</label>
        <TextInput
          id="transfer-code"
          size="lg"
          value={invitation}
          onChange={(e) => setInvitation(e.target.value)}
          autoFocus
          autoCapitalize="none"
        />
        <small className="field__hint">
          Only the client ID and secret are transferred. You will sign in to Google separately.
        </small>
      </div>
      <p className="guide-why">
        Approve the connection on your other device when prompted, then finish signing in with
        Google.
      </p>
      <div className="onboarding-footer">
        <Button variant="ghost" size="lg" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" variant="primary" size="lg" disabled={!invitation.trim()}>
          Connect securely
        </Button>
      </div>
    </form>
  );
}
