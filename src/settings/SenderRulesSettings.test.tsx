import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { useToastStore } from "../components/ui/Toast";
import { useAccountStore } from "../store/accountStore";
import { SenderRulesSettings } from "./SenderRulesSettings";

let rules: Record<string, Array<{ id: string; sender: string; category: string }>>;
let deleted: unknown[];
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  deleted = [];
  rules = {
    a1: [{ id: "f1", sender: "news@x.com", category: "CATEGORY_UPDATES" }],
    a2: [],
  };
  useAccountStore.setState({
    accounts: [
      { id: "a1", email: "one@example.com" } as never,
      { id: "a2", email: "two@example.com" } as never,
      { id: "a3", email: "old@example.com" } as never,
    ],
  });
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, string>;
    if (cmd === "list_sender_rules") {
      if (a.accountId === "a3") throw { code: "missing_scope", message: "Insufficient Permission" };
      return rules[a.accountId];
    }
    if (cmd === "delete_sender_rule") {
      deleted.push(a);
      return undefined;
    }
    return undefined;
  });
});
afterEach(() => clearMocks());

test("lists each account's rules, deletes one, and asks old accounts to sign in again", async () => {
  render(<SenderRulesSettings />);
  await flush();
  const one = screen.getByRole("region", { name: "Sender rules · one@example.com" });
  expect(one).toHaveTextContent("news@x.com");
  expect(one).toHaveTextContent("Goes to Updates");
  expect(screen.getByRole("region", { name: "Sender rules · two@example.com" })).toHaveTextContent(
    "No sender rules",
  );
  const old = screen.getByRole("region", { name: "Sender rules · old@example.com" });
  expect(old).toHaveTextContent("can't see this account's Gmail filters");
  expect(screen.getByRole("button", { name: "Sign in again" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Delete the rule for news@x.com" }));
  await flush();
  expect(deleted).toEqual([{ accountId: "a1", ruleId: "f1" }]);
  expect(one).not.toHaveTextContent("news@x.com");
});

test("a delete Gmail refuses keeps the list and says why", async () => {
  useAccountStore.setState({ accounts: [{ id: "a1", email: "one@example.com" } as never] });
  mockIPC((cmd) => {
    if (cmd === "list_sender_rules") return rules.a1;
    if (cmd === "delete_sender_rule")
      throw { code: "network", message: "Google can't be reached." };
    return undefined;
  });
  render(<SenderRulesSettings />);
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Delete the rule for news@x.com" }));
  await flush();
  const section = screen.getByRole("region", { name: "Sender rules" });
  expect(section).toHaveTextContent("news@x.com");
  expect(section).not.toHaveTextContent("Couldn't load sender rules");
  expect(useToastStore.getState().toasts).toContainEqual(
    expect.objectContaining({
      title: "Couldn't delete the rule for news@x.com",
      description: "Google can't be reached.",
      tone: "danger",
    }),
  );
});

test("while rules load, the section shows a placeholder shaped like a rule, not a Loading message", async () => {
  useAccountStore.setState({ accounts: [{ id: "a1", email: "one@example.com" } as never] });
  mockIPC((cmd) => (cmd === "list_sender_rules" ? new Promise(() => {}) : undefined));
  render(<SenderRulesSettings />);
  const one = screen.getByRole("region", { name: "Sender rules" });
  expect(one).not.toHaveTextContent(/loading/i);
  expect(one.querySelectorAll(".settings-row")).toHaveLength(1);
  expect(one.querySelectorAll(".ui-skeleton").length).toBeGreaterThan(0);
});
