import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { AccountInfo } from "../lib/tauri";
import { Onboarding } from "../onboarding/Onboarding";
import { SendCredentials } from "./SendCredentials";
import type { TransferOffer } from "./api";

const account: AccountInfo = {
  id: "a1",
  clientId: "test.apps.googleusercontent.com",
  email: "me@example.com",
  displayName: null,
  synced: true,
};
const invitation = "pheeme-transfer-v1:192.168.1.2:1234/PRIVATE-PAIRING-KEY";
const offer: TransferOffer = { transferId: "transfer-1", invitation, expiresInSeconds: 300 };
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

function backend(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> });
    return handlers[cmd]?.(args as Record<string, unknown>);
  });
  return calls;
}

beforeEach(() => localStorage.clear());

test("receiving waits for native transfer approval, then uses normal Google sign-in without exposing credentials", async () => {
  let approve!: (start: { flowId: string; authUrl: string }) => void;
  const calls = backend({
    receive_client_transfer: () =>
      new Promise((resolve) => {
        approve = resolve;
      }),
    complete_oauth: () => account,
  });
  const connected = vi.fn();
  render(<Onboarding accounts={[]} onConnected={connected} />);
  click("Receive from another device");
  fireEvent.change(screen.getByLabelText("Transfer code"), { target: { value: invitation } });
  click("Connect securely");
  expect(
    screen.getByRole("heading", { name: "Waiting for the sending device" }),
  ).toBeInTheDocument();
  expect(calls.some((c) => c.cmd === "open_external" || c.cmd === "begin_oauth")).toBe(false);
  expect(JSON.stringify(localStorage)).not.toContain("PRIVATE-PAIRING-KEY");
  expect(calls.find((c) => c.cmd === "receive_client_transfer")?.args.invitation).toBe(invitation);
  await act(async () =>
    approve({ flowId: "received-flow", authUrl: "https://accounts.google.com/test" }),
  );
  expect(calls).toContainEqual({ cmd: "complete_oauth", args: { flowId: "received-flow" } });
  click("Continue");
  expect(connected).toHaveBeenCalledWith(account);
});

test("cancelling a receiver cancels the native transfer and discards late sign-in responses", async () => {
  let finish!: (start: { flowId: string; authUrl: string }) => void;
  const calls = backend({
    receive_client_transfer: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  render(<Onboarding accounts={[]} onConnected={() => {}} />);
  click("Receive from another device");
  fireEvent.change(screen.getByLabelText("Transfer code"), { target: { value: invitation } });
  click("Connect securely");
  const id = calls.find((c) => c.cmd === "receive_client_transfer")!.args.transferId;
  click("Cancel transfer");
  expect(calls).toContainEqual({ cmd: "cancel_client_transfer", args: { transferId: id } });
  expect(screen.getByLabelText("Transfer code")).toHaveValue("");
  await act(async () =>
    finish({ flowId: "late-flow", authUrl: "https://accounts.google.com/test" }),
  );
  expect(calls).toContainEqual({ cmd: "cancel_oauth", args: { flowId: "late-flow" } });
  expect(calls.some((c) => c.cmd === "open_external" || c.cmd === "complete_oauth")).toBe(false);
});

test("leaving receiver onboarding cancels the pending native transfer", async () => {
  const calls = backend({ receive_client_transfer: () => new Promise(() => {}) });
  const { unmount } = render(<Onboarding accounts={[]} onConnected={() => {}} />);
  click("Receive from another device");
  fireEvent.change(screen.getByLabelText("Transfer code"), { target: { value: invitation } });
  click("Connect securely");
  unmount();
  expect(calls.some((c) => c.cmd === "cancel_client_transfer")).toBe(true);
});

test("sender requires explicit approval and closing settings cancels its native session", async () => {
  const calls = backend({
    transfer_interfaces: () => ["192.168.1.2"],
    offer_client_transfer: () => offer,
    client_transfer_status: () => ({ phase: "approval", peer: "192.168.1.3", error: null }),
  });
  const { unmount } = render(<SendCredentials accounts={[account]} />);
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "Send to another device" })).toBeEnabled(),
  );
  click("Send to another device");
  await screen.findByRole("button", { name: "Approve transfer" });
  expect(calls.some((c) => c.cmd === "approve_client_transfer")).toBe(false);
  expect(screen.getByText(invitation)).toBeInTheDocument();
  click("Approve transfer");
  await vi.waitFor(() =>
    expect(calls).toContainEqual({
      cmd: "approve_client_transfer",
      args: { transferId: offer.transferId },
    }),
  );
  unmount();
  expect(calls).toContainEqual({
    cmd: "cancel_client_transfer",
    args: { transferId: offer.transferId },
  });
});

test("a late offer created after closing settings is immediately cancelled", async () => {
  let finish!: (offer: TransferOffer) => void;
  const calls = backend({
    transfer_interfaces: () => ["192.168.1.2"],
    offer_client_transfer: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const { unmount } = render(<SendCredentials accounts={[account]} />);
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "Send to another device" })).toBeEnabled(),
  );
  click("Send to another device");
  unmount();
  await act(async () => finish(offer));
  expect(calls).toContainEqual({
    cmd: "cancel_client_transfer",
    args: { transferId: offer.transferId },
  });
});

test("connection failures clear the code and offer a fresh receiving attempt", async () => {
  backend({
    receive_client_transfer: () => {
      throw { code: "transfer_connection", message: "Check the local network." };
    },
  });
  render(<Onboarding accounts={[]} onConnected={() => {}} />);
  click("Receive from another device");
  fireEvent.change(screen.getByLabelText("Transfer code"), { target: { value: invitation } });
  click("Connect securely");
  expect(await screen.findByRole("alert")).toHaveTextContent("Check the local network.");
  expect(screen.getByLabelText("Transfer code")).toHaveValue("");
});
