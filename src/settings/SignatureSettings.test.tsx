import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { __resetSignaturesForTests, useSignatures } from "../compose/signatures";
import { useAccountStore } from "../store/accountStore";
import { SignatureSettings } from "./SignatureSettings";

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  localStorage.clear();
  __resetSignaturesForTests();
  useAccountStore.setState({
    accounts: [
      { id: "a1", email: "one@example.com" } as never,
      { id: "a2", email: "two@example.com" } as never,
      { id: "a3", email: "old@example.com" } as never,
    ],
  });
  mockIPC((cmd, args) => {
    if (cmd !== "gmail_signature") return undefined;
    const { accountId } = args as { accountId: string };
    if (accountId === "a3") throw { code: "missing_scope", message: "Insufficient Permission" };
    return accountId === "a1" ? '<b>One</b><img src="https://x/logo.png" onerror="bad()">' : null;
  });
});
afterEach(() => clearMocks());

test("shows each account's Gmail signature, and asks old accounts to sign in again", async () => {
  render(<SignatureSettings />);
  await flush();
  const one = screen.getByRole("region", { name: "one@example.com" });
  expect(one.querySelector(".signature-preview b")?.textContent).toBe("One");
  expect(one.querySelector(".signature-preview img")?.hasAttribute("onerror")).toBe(false);
  expect(screen.getByRole("region", { name: "two@example.com" })).toHaveTextContent(
    "None set in Gmail",
  );
  const old = screen.getByRole("region", { name: "old@example.com" });
  expect(old).toHaveTextContent("can't see this account's Gmail settings");
  expect(within(old).getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
});

test("separate choices for new messages and for replies, and an own signature", async () => {
  render(<SignatureSettings />);
  await flush();
  const one = screen.getByRole("region", { name: "one@example.com" });
  const replies = within(one).getByRole("radiogroup", {
    name: "Signature for replies and forwards from one@example.com",
  });
  fireEvent.click(within(replies).getByRole("radio", { name: "None" }));
  expect(useSignatures.getState().forAccount("a1")).toMatchObject({
    newMessages: "gmail",
    replies: "none",
  });
  expect(useSignatures.getState().signatureFor("a1", "reply")).toBeNull();
  expect(useSignatures.getState().signatureFor("a1", "new")).toContain("One");

  // The own-signature editor loads lazily.
  expect(
    await within(one).findByRole("textbox", { name: "Your own signature for one@example.com" }),
  ).toBeInTheDocument();
});
