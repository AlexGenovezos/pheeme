import type { SignInStart } from "../lib/tauri";
import type { TransferOffer, TransferStatus } from "../transfer/api";

/** Simulates a second device for UI development; no real credentials or sockets. */
export function createTransferHandlers(beginSignIn: () => SignInStart) {
  let offer: TransferOffer | null = null;
  let phase: TransferStatus["phase"] = "waiting";
  return {
    transfer_interfaces: () => ["192.168.1.20"],
    offer_client_transfer: (): TransferOffer => {
      phase = "waiting";
      offer = {
        transferId: crypto.randomUUID(),
        invitation: "pheeme-transfer-v1:192.168.1.20:49152/preview-code-for-ui-development-only",
        expiresInSeconds: 300,
      };
      return offer;
    },
    client_transfer_status: (): TransferStatus => {
      if (!offer) throw { code: "transfer_expired", message: "Transfer cancelled." };
      if (phase === "waiting") phase = "approval";
      return { phase, peer: "192.168.1.21", error: null };
    },
    approve_client_transfer: () => {
      phase = "completed";
    },
    cancel_client_transfer: () => {
      offer = null;
    },
    receive_client_transfer: () => beginSignIn(),
  };
}
