import { useState } from "react";
import { Button } from "../components/ui/Button";
import { TextInput } from "../components/ui/TextInput";
import "./transfer.css";

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
      className="client-transfer"
      onSubmit={(e) => {
        e.preventDefault();
        if (invitation.trim()) {
          onReceive(invitation.trim());
          setInvitation("");
        }
      }}
    >
      <h1>Receive from another device</h1>
      <p>
        On your other device, open Settings → Accounts → Send to another device. Both devices must
        be on the same local network.
      </p>
      <label htmlFor="transfer-code">Transfer code</label>
      <TextInput
        id="transfer-code"
        value={invitation}
        onChange={(e) => setInvitation(e.target.value)}
        autoFocus
        autoCapitalize="none"
      />
      <p>
        After connecting, approve the transfer on the sending device. Pheeme then opens Google so
        you can sign in. The transfer includes only the client ID and secret.
      </p>
      <div className="button-row">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" variant="primary" disabled={!invitation.trim()}>
          Connect securely
        </Button>
      </div>
    </form>
  );
}
