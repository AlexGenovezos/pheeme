// Each account's vacation responder as Gmail last answered. Never cached on disk: it's read when
// the app starts, every 15 minutes and on coming back to the window (at most every 5), and when
// Settings › Vacation responder opens, so a change made on another device shows here too.
import { useEffect } from "react";
import { create } from "zustand";
import {
  type CommandError,
  endVacationResponder,
  getVacationResponder,
  setVacationResponder,
  toCommandError,
  type VacationResponder,
} from "../lib/tauri";
import type { VacationForm } from "./form";

export interface AccountVacation {
  /** Gmail's last answer; `undefined` until the first read finishes. */
  value?: VacationResponder;
  /** Why the last read failed (`missing_scope`: the account hasn't allowed its basic mail settings). */
  error?: CommandError;
  /** When Gmail last answered or failed (ms). */
  at?: number;
}

interface VacationState {
  accounts: Record<string, AccountVacation>;
  /** Unsaved edits in Settings, per account, until saved or discarded (this session only). */
  drafts: Record<string, VacationForm>;
  setDraft(accountId: string, form: VacationForm | null): void;
  /** Read the account's responder from Gmail. */
  refresh(accountId: string): Promise<void>;
  /** Save it to Gmail; resolves to the failure, or `null` once Gmail has it. */
  save(accountId: string, responder: VacationResponder): Promise<CommandError | null>;
  /** Gmail's End now. */
  end(accountId: string): Promise<CommandError | null>;
}

const inflight = new Map<string, Promise<void>>();
/** Bumped by each successful write, so a read that started before it can't put back the old state. */
const writes = new Map<string, number>();

export const useVacation = create<VacationState>((set) => {
  const patch = (accountId: string, change: AccountVacation) =>
    set((s) => ({
      accounts: { ...s.accounts, [accountId]: { ...s.accounts[accountId], ...change } },
    }));
  const write = async (accountId: string, run: () => Promise<VacationResponder>) => {
    try {
      const value = await run();
      writes.set(accountId, (writes.get(accountId) ?? 0) + 1);
      patch(accountId, { value, error: undefined, at: Date.now() });
      return null;
    } catch (e) {
      return toCommandError(e);
    }
  };
  return {
    accounts: {},
    drafts: {},
    setDraft: (accountId, form) =>
      set((s) => {
        const drafts = { ...s.drafts };
        if (form) drafts[accountId] = form;
        else delete drafts[accountId];
        return { drafts };
      }),
    refresh(accountId) {
      const running = inflight.get(accountId);
      if (running) return running;
      const before = writes.get(accountId);
      const current = () => writes.get(accountId) === before;
      const run = getVacationResponder(accountId)
        .then(
          (value) => {
            if (current()) patch(accountId, { value, error: undefined, at: Date.now() });
          },
          // A failed re-read keeps the last answer, so the notice doesn't flicker away offline.
          (e: unknown) => {
            if (current()) patch(accountId, { error: toCommandError(e), at: Date.now() });
          },
        )
        .finally(() => inflight.delete(accountId));
      inflight.set(accountId, run);
      return run;
    },
    save: (accountId, responder) =>
      write(accountId, () => setVacationResponder(accountId, responder)),
    end: (accountId) => write(accountId, () => endVacationResponder(accountId)),
  };
});

const REFRESH_MS = 15 * 60_000;
const FOCUS_MS = 5 * 60_000;

/** Keeps every account's responder current while the app runs. */
export function useVacationRefresh(accountIds: string[]) {
  const key = accountIds.join(",");
  useEffect(() => {
    const ids = key ? key.split(",") : [];
    const { refresh } = useVacation.getState();
    for (const id of ids) void refresh(id);
    const timer = setInterval(() => ids.forEach((id) => void refresh(id)), REFRESH_MS);
    const onFocus = () => {
      const { accounts } = useVacation.getState();
      for (const id of ids) if (Date.now() - (accounts[id]?.at ?? 0) >= FOCUS_MS) void refresh(id);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [key]);
}
