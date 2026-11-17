import { mockIPC } from "@tauri-apps/api/mocks";
import { act, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import type { AccountInfo, QuotaUsage } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { AccountsSettings } from "./AccountsSettings";

const SHARED = "418203915572-sharedaaaa.apps.googleusercontent.com";
const OWN = "730561248890-ownbbbb.apps.googleusercontent.com";

const account = (id: string, clientId: string): AccountInfo => ({
  id,
  email: `${id}@example.com`,
  displayName: null,
  clientId,
  synced: true,
  color: 1,
});

/** An hour where the account spent `units` in its last minute. */
function usage(units: number): QuotaUsage {
  const now = Math.floor(Date.now() / 60_000);
  return {
    limitPerMinute: 6_000,
    minutes: Array.from({ length: 60 }, (_, i) => ({
      startMs: (now - 59 + i) * 60_000,
      units: {
        newMail: i === 59 ? units : 0,
        olderMail: 0,
        yourChanges: 0,
        youAsked: 0,
        assistants: 0,
      },
      refused: 0,
    })),
  };
}

const UNITS: Record<string, number> = { a: 1_200, b: 300, c: 50 };

beforeEach(() => {
  mockIPC((cmd, args) => {
    if (cmd === "gmail_quota_usage") {
      return usage(UNITS[(args as { accountId: string }).accountId] ?? 0);
    }
    if (cmd === "get_sync_progress") return [];
    if (cmd === "list_calendar_accounts") return [];
  });
  useAccountStore.setState({ syncErrors: {} });
});

const flush = () => act(async () => {});

test("accounts on one Google Cloud app share a card, with the quota they used together", async () => {
  useAccountStore.setState({
    accounts: [account("a", SHARED), account("b", OWN), account("c", SHARED)],
  });
  render(<AccountsSettings />);
  await flush();

  const shared = screen.getByText("Project 418203915572 · client …aaaa").closest(".settings-card")!;
  expect(within(shared as HTMLElement).getByText("a@example.com")).toBeInTheDocument();
  expect(within(shared as HTMLElement).getByText("c@example.com")).toBeInTheDocument();
  expect(within(shared as HTMLElement).queryByText("b@example.com")).toBeNull();
  expect(shared).toHaveTextContent(
    "Shared by 2 accounts, which used 1,250 Gmail quota units together in the last hour",
  );

  const own = screen.getByText("Project 730561248890 · client …bbbb").closest(".settings-card")!;
  expect(own).toHaveTextContent("Only b@example.com signs in through it.");
  // Each account keeps its own chart: Gmail's limit is per account.
  expect(screen.getAllByText("Gmail quota, last hour")).toHaveLength(3);
});

test("a lone account doesn't name its Google Cloud app", async () => {
  useAccountStore.setState({ accounts: [account("a", SHARED)] });
  render(<AccountsSettings />);
  await flush();
  expect(screen.getByText("a@example.com")).toBeInTheDocument();
  expect(screen.queryByText("Google Cloud app")).toBeNull();
});
