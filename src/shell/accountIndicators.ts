import { create } from "zustand";
import { defaultStorage, readJson, writeJson } from "../lib/storage";
import { accountColorIndex } from "../mail/mailboxes";
import { useAccountStore } from "../store/accountStore";
import { useUiStore } from "../store/uiStore";

/**
 * Settings › Appearance › Current account: the ways the mail view shows which account you're in. Each only shows
 * with more than one account and in one account's mailbox (All Inboxes is every account), except the rail, which is
 * how you move between accounts.
 */
export interface AccountIndicators {
  /** The current account's group in the sidebar glows in its color. */
  glow: boolean;
  /** A stripe of the current account's color along the top of the window, and a tint behind the list's title. */
  windowColor: boolean;
  /** A column of account icons beside the sidebar, which then shows one account at a time. */
  rail: boolean;
}

export const ACCOUNT_INDICATORS_KEY = "pheeme.account-indicators";

export const DEFAULT_ACCOUNT_INDICATORS: AccountIndicators = {
  glow: true,
  windowColor: false,
  rail: false,
};

export function readAccountIndicators(
  storage: Pick<Storage, "getItem"> | undefined = defaultStorage(),
): AccountIndicators {
  const raw = readJson(ACCOUNT_INDICATORS_KEY, storage);
  const stored = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const flag = (key: keyof AccountIndicators) =>
    typeof stored[key] === "boolean" ? stored[key] : DEFAULT_ACCOUNT_INDICATORS[key];
  return { glow: flag("glow"), windowColor: flag("windowColor"), rail: flag("rail") };
}

interface AccountIndicatorsStore extends AccountIndicators {
  set(key: keyof AccountIndicators, on: boolean): void;
}

export const useAccountIndicators = create<AccountIndicatorsStore>((set, get) => ({
  ...readAccountIndicators(),
  set(key, on) {
    set({ [key]: on });
    const { glow, windowColor, rail } = get();
    writeJson(ACCOUNT_INDICATORS_KEY, { glow, windowColor, rail });
  },
}));

/** The rail shows only with more than one account: with one there is nothing to move between. */
export function useRailShown(): boolean {
  const rail = useAccountIndicators((s) => s.rail);
  const several = useAccountStore((s) => s.accounts.length > 1);
  return rail && several;
}

/**
 * Settings › Appearance › Account color across the window: the open mailbox's account color (a CSS `var()`), or null
 * when it's off, in All Inboxes, or with one account.
 */
export function useWindowColor(): string | null {
  const on = useAccountIndicators((s) => s.windowColor);
  const accounts = useAccountStore((s) => s.accounts);
  const current = useUiStore((s) => s.mailbox.accountId);
  if (!on || accounts.length < 2 || current === null) return null;
  return `var(--color-account-${accountColorIndex(current, accounts)})`;
}
