import { Check, ChevronDown, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/Button";
import { type AccountInfo, toCommandError } from "../lib/tauri";
import { showContextMenu } from "../lib/contextMenu";
import { SettingsRow } from "../settings/rows";
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
  // null until the interfaces load, so the "no network" note can't flash first.
  const [addresses, setAddresses] = useState<string[] | null>(null);
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
        if (!active) return;
        setAddresses([]);
        setError(toCommandError(raw).message);
      });
    return () => {
      // oxlint-disable-next-line react/immutability -- This flag belongs to this effect invocation.
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
        // oxlint-disable-next-line react/immutability -- The timer handle belongs to this effect invocation.
        timer = setTimeout(() => void poll(), 750);
      } catch (raw) {
        if (active) {
          setError(toCommandError(raw).message);
          // oxlint-disable-next-line react/immutability -- Function declarations are hoisted before this callback runs.
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
    if (!selected) return;
    const current = ++attempt.current;
    setBusy(true);
    setError("");
    setStatus(null);
    setCopied(false);
    try {
      const next = await offerClientTransfer(selected.id, address);
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

  const selected = clients.find((a) => a.id === accountId) ?? clients[0];
  const completed = status?.phase === "completed";

  return (
    <>
      <SettingsRow
        title={
          offer ? "Set up another device" : completed ? "Credentials sent" : "Client credentials"
        }
        description={
          offer
            ? "On the new device, choose Receive from another device during setup."
            : completed
              ? "Continue signing in to Google on your other device."
              : "Reuse your Google Cloud app on another device on the same network."
        }
        control={
          offer || busy ? (
            <Button variant="ghost" size="sm" onClick={cancel}>
              Cancel transfer
            </Button>
          ) : (
            <Button size="sm" disabled={!address || !selected} onClick={() => void start()}>
              {completed ? "Send again" : "Send to another device"}
            </Button>
          )
        }
      />
      {!offer && !completed && (
        <>
          {clients.length > 1 && (
            <SettingsRow
              title="Google Cloud app"
              description="Choose which client to share."
              control={
                <Choice
                  label="Google Cloud app"
                  value={selected?.id ?? ""}
                  options={clients.map((a) => ({ value: a.id, label: a.email }))}
                  disabled={busy}
                  onChange={setAccountId}
                />
              }
            />
          )}
          {addresses && addresses.length > 1 && (
            <SettingsRow
              title="Network"
              description="Choose your Wi-Fi or Ethernet address."
              control={
                <Choice
                  label="Local network address"
                  value={address}
                  options={addresses.map((ip) => ({ value: ip, label: ip }))}
                  disabled={busy}
                  onChange={setAddress}
                />
              }
            />
          )}
          {addresses && !address && (
            <p className="transfer-note">Connect to Wi-Fi or Ethernet, then reopen this page.</p>
          )}
        </>
      )}
      {offer && (
        <>
          <div className="transfer-pairing">
            <div className="transfer-pairing__label">
              <span>Transfer code</span>
              <span>Expires in {Math.ceil(offer.expiresInSeconds / 60)} minutes</span>
            </div>
            <div className="transfer-pairing__code">
              <code>{offer.invitation}</code>
              <Button
                size="sm"
                icon={copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                onClick={() =>
                  void navigator.clipboard.writeText(offer.invitation).then(
                    () => setCopied(true),
                    () => setError("Couldn't copy. Select the code and copy it manually."),
                  )
                }
              >
                {copied ? "Copied" : "Copy transfer code"}
              </Button>
            </div>
            <p className="transfer-pairing__hint">
              Keep this code private. You will approve the connection here before anything is sent.
            </p>
          </div>
          <SettingsRow
            title={
              <span role="status">
                {status?.phase === "approval"
                  ? "Allow this device?"
                  : status?.phase === "sending"
                    ? "Sending securely…"
                    : "Waiting for the other device…"}
              </span>
            }
            description={
              status?.phase === "approval"
                ? `${status.peer} entered your code. Approve only if this is your other device.`
                : undefined
            }
            control={
              status?.phase === "approval" && (
                <Button variant="primary" size="sm" disabled={busy} onClick={() => void approve()}>
                  Approve transfer
                </Button>
              )
            }
          />
        </>
      )}
      {(error || status?.error) && (
        <p className="transfer-note transfer-note--error" role="alert">
          {error || status?.error}
        </p>
      )}
    </>
  );
}

/** Use the same native menu and compact action styling as the rest of the app. */
function Choice({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="transfer-choice"
      aria-label={label}
      aria-haspopup="menu"
      disabled={disabled}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        void showContextMenu(
          options.map((option) => ({
            id: option.value,
            label: option.label,
            checked: option.value === value,
            onSelect: () => onChange(option.value),
          })),
          { x: rect.left, y: rect.bottom },
        );
      }}
    >
      {options.find((option) => option.value === value)?.label}
      <ChevronDown aria-hidden="true" />
    </Button>
  );
}
