import { useEffect, useState } from "react";
import { Button } from "../components/ui/Button";
import { TextInput } from "../components/ui/TextInput";
import { type LocalNetworkAccess, localNetworkAccess, openLocalNetworkSettings } from "./api";
import "./transfer.css";

/**
 * Asks for macOS Local Network access as soon as the screen opens, so the prompt is
 * answered before the first connection; while blocked, checks again every second.
 */
function useLocalNetworkAccess() {
  const [access, setAccess] = useState<LocalNetworkAccess | null>(null);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      const next = await localNetworkAccess().catch(() => "granted" as const);
      if (!active) return;
      setAccess(next === "blocked" ? "blocked" : "granted");
      // oxlint-disable-next-line react/immutability -- The timer handle belongs to this effect invocation.
      if (next === "blocked") timer = setTimeout(() => void check(), 1000);
    }
    void check();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);
  return access;
}

export function ReceiveCredentials({
  onReceive,
  onBack,
}: {
  onReceive: (invitation: string) => void;
  onBack: () => void;
}) {
  const [invitation, setInvitation] = useState("");
  const blocked = useLocalNetworkAccess() === "blocked";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (invitation.trim() && !blocked) {
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
      {blocked && (
        <div className="transfer-permission" role="alert">
          <p>
            Allow Pheeme to use your local network to reach your other device. Choose Allow in the
            macOS prompt, or turn on Pheeme in System Settings → Privacy &amp; Security → Local
            Network.
          </p>
          <Button size="sm" onClick={() => void openLocalNetworkSettings().catch(() => {})}>
            Open System Settings
          </Button>
        </div>
      )}
      <p className="guide-why">
        Approve the connection on your other device when prompted, then finish signing in with
        Google.
      </p>
      <div className="onboarding-footer">
        <Button variant="ghost" size="lg" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" variant="primary" size="lg" disabled={!invitation.trim() || blocked}>
          Connect securely
        </Button>
      </div>
    </form>
  );
}
