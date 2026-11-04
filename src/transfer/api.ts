import { invoke } from "@tauri-apps/api/core";
import type { SignInStart } from "../lib/tauri";

export interface TransferOffer {
  transferId: string;
  invitation: string;
  expiresInSeconds: number;
}
export interface TransferStatus {
  phase: "waiting" | "approval" | "sending" | "completed" | "failed";
  peer: string | null;
  error: string | null;
}
export const transferInterfaces = () => invoke<string[]>("transfer_interfaces");
export const offerClientTransfer = (accountId: string, address: string) =>
  invoke<TransferOffer>("offer_client_transfer", { accountId, address });
export const clientTransferStatus = (transferId: string) =>
  invoke<TransferStatus>("client_transfer_status", { transferId });
export const approveClientTransfer = (transferId: string) =>
  invoke<void>("approve_client_transfer", { transferId });
export const cancelClientTransfer = (transferId: string) =>
  invoke<void>("cancel_client_transfer", { transferId });
export const receiveClientTransfer = (transferId: string, invitation: string) =>
  invoke<SignInStart>("receive_client_transfer", { transferId, invitation });
