import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/Button";
import { type AccountInfo, toCommandError } from "../lib/tauri";
import {
  approveClientTransfer,
  cancelClientTransfer,
  clientTransferStatus,
  offerClientTransfer,
  type TransferOffer,
  type TransferStatus,
  transferInterfaces,
} from "./api";
import "./transfer.css";

export function SendCredentials({ accounts }: { accounts: AccountInfo[] }) {
  const clients = [...new Map(accounts.map((a) => [a.clientId, a])).values()];
  const [accountId, setAccountId] = useState(clients[0]?.id ?? "");
  const [addresses, setAddresses] = useState<string[]>([]);
  const [address, setAddress] = useState("");
  const [offer, setOffer] = useState<TransferOffer | null>(null);
  const [status, setStatus] = useState<TransferStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const attempt = useRef(0);
  const session = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    void transferInterfaces()
      .then((ips) => {
        if (!active) return;
        setAddresses(ips);
        setAddress(ips[0] ?? "");
      })
      .catch((raw) => {
        if (active) setError(toCommandError(raw).message);
      });
    return () => {
      active = false;
      attempt.current += 1;
      if (session.current) void cancelClientTransfer(session.current).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!offer) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await clientTransferStatus(offer!.transferId);
        if (!active) return;
        setStatus(next);
        if (next.phase === "completed" || next.phase === "failed") {
          setOffer(null);
          session.current = null;
          return;
        }
        timer = setTimeout(() => void poll(), 750);
      } catch (raw) {
        if (active) {
          setError(toCommandError(raw).message);
          cancel();
        }
      }
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [offer]);

  function cancel() {
    attempt.current += 1;
    if (session.current) void cancelClientTransfer(session.current).catch(() => {});
    session.current = null;
    setOffer(null);
    setStatus(null);
    setBusy(false);
  }

  async function start() {
    const current = ++attempt.current;
    setBusy(true);
    setError("");
    setStatus(null);
    setCopied(false);
    try {
      const next = await offerClientTransfer(accountId, address);
      if (current !== attempt.current) {
        void cancelClientTransfer(next.transferId).catch(() => {});
        return;
      }
      session.current = next.transferId;
      setOffer(next);
    } catch (raw) {
      if (current === attempt.current) setError(toCommandError(raw).message);
    } finally {
      if (current === attempt.current) setBusy(false);
    }
  }

  async function approve() {
    if (!offer) return;
    const current = attempt.current;
    setBusy(true);
    try {
      await approveClientTransfer(offer.transferId);
      if (current !== attempt.current) return;
      setStatus((s) => (s ? { ...s, phase: "sending" } : s));
    } catch (raw) {
      if (current === attempt.current) setError(toCommandError(raw).message);
    } finally {
      if (current === attempt.current) setBusy(false);
    }
  }

  return (
    <div className="client-transfer">
      <p>
        Send this Google Cloud app's client ID and secret to Pheeme on another device on the same
        network. You will sign in to Google separately there.
      </p>
      {!offer && (
        <>
          <label htmlFor="transfer-account">Google Cloud app</label>
          <select
            id="transfer-account"
            value={accountId}
            disabled={busy}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {clients.map((a) => (
              <option key={a.id} value={a.id}>
                The app used by {a.email}
              </option>
            ))}
          </select>
          <label htmlFor="transfer-address">Local network address</label>
          <select
            id="transfer-address"
            value={address}
            disabled={busy}
            onChange={(e) => setAddress(e.target.value)}
          >
            {addresses.map((ip) => (
              <option key={ip} value={ip}>
                {ip}
              </option>
            ))}
          </select>
          {!address && (
            <p>No local IPv4 address found. Connect to Wi-Fi or Ethernet and reopen this page.</p>
          )}
          <Button disabled={busy || !address || !accountId} onClick={() => void start()}>
            Send to another device
          </Button>
          {busy && (
            <Button variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          )}
        </>
      )}
      {offer && (
        <>
          <p>
            On the other device, choose “Receive from another device” during setup and enter this
            code. Keep it private; it expires in {Math.ceil(offer.expiresInSeconds / 60)} minutes.
          </p>
          <code className="client-transfer__code">{offer.invitation}</code>
          <Button
            onClick={() =>
              void navigator.clipboard.writeText(offer.invitation).then(
                () => setCopied(true),
                () => setError("Couldn't copy. Select the code and copy it manually."),
              )
            }
          >
            {copied ? "Copied" : "Copy transfer code"}
          </Button>
          {status?.phase === "approval" ? (
            <>
              <p role="status">
                A device at {status.peer} has entered your code. Approve only if you just requested
                this transfer on your other device.
              </p>
              <Button variant="primary" disabled={busy} onClick={() => void approve()}>
                Approve transfer
              </Button>
            </>
          ) : (
            <p role="status">
              {status?.phase === "sending" ? "Sending securely…" : "Waiting for the other device…"}
            </p>
          )}
          <Button variant="ghost" onClick={cancel}>
            Cancel transfer
          </Button>
        </>
      )}
      {status?.phase === "completed" && (
        <p role="status">
          Credentials received by the other device. Continue signing in to Google there.
        </p>
      )}
      {(error || status?.error) && <p role="alert">{error || status?.error}</p>}
      <p>
        If the connection fails, check that both devices are on the same network and allow Pheeme
        through the sending device's firewall. Guest Wi-Fi may block device connections.
      </p>
    </div>
  );
}
