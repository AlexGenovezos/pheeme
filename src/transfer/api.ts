import { call } from "../lib/ipc/call";

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
/** macOS asks for Local Network access the first time; "blocked" until the user allows it. */
export type LocalNetworkAccess = "granted" | "blocked";
export const localNetworkAccess = () => call("local_network_access");
export const openLocalNetworkSettings = () => call("open_local_network_settings");
export const transferInterfaces = () => call("transfer_interfaces");
export const offerClientTransfer = (accountId: string, address: string) =>
  call("offer_client_transfer", { accountId, address });
export const clientTransferStatus = (transferId: string) =>
  call("client_transfer_status", { transferId });
export const approveClientTransfer = (transferId: string) =>
  call("approve_client_transfer", { transferId });
export const cancelClientTransfer = (transferId: string) =>
  call("cancel_client_transfer", { transferId });
export const receiveClientTransfer = (transferId: string, invitation: string) =>
  call("receive_client_transfer", { transferId, invitation });
