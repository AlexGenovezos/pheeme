/** The vacation responder for browser preview, with the backend's rules (`src-tauri/src/vacation.rs`). */

import type { AccountInfo, VacationResponder } from "../lib/tauri";
import type { PartialHandlers } from "./handlers";

const DAY_MS = 86_400_000;

/** Local midnight of the day `offset` days from today. */
const day = (offset: number) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d.getTime();
};

/**
 * `?vacation=on`: the first account's responder is on, through next week. `?vacation=missing`:
 * every account answers as one that never allowed its basic mail settings. `?vacation=readonly`:
 * reads work but saving is refused, as for an account that signed in before Pheeme asked for
 * those settings (Gmail lets the mail scope read the responder, not change it). The first account
 * stands in for a personal (gmail.com) account and the others for Workspace ones, so both
 * shapes of the form show.
 */
export function createVacationHandlers(accounts: AccountInfo[], mode: string | null) {
  const workspace = (accountId: string) => accounts.findIndex((a) => a.id === accountId) > 0;
  const responders = new Map<string, VacationResponder>();
  const of = (accountId: string): VacationResponder =>
    responders.get(accountId) ?? {
      enabled: false,
      subject: "",
      html: "",
      onlyContacts: false,
      onlyDomain: false,
      startMs: null,
      endMs: null,
      workspace: workspace(accountId),
    };
  if (mode === "on" && accounts[0]) {
    responders.set(accounts[0].id, {
      ...of(accounts[0].id),
      enabled: true,
      subject: "Out of office",
      html: "<p>Thanks for your email. I'm away with limited access to mail, back <b>next week</b>.</p><p>For anything urgent, write to studio@example.org.</p>",
      onlyContacts: true,
      startMs: day(-2),
      endMs: day(7) + DAY_MS,
    });
  }
  const gmail = (write = false) => {
    if (mode === "missing" || (write && mode === "readonly"))
      throw {
        code: "missing_scope",
        message: "Gmail API error 403 (insufficientPermissions): Insufficient Permission",
      };
  };
  return {
    get_vacation_responder: (args): VacationResponder => {
      gmail();
      return { ...of(args.accountId) };
    },
    set_vacation_responder: (args): VacationResponder => {
      const r = args.responder;
      if (r.startMs !== null && r.endMs !== null && r.endMs <= r.startMs)
        throw { code: "invalid_input", message: "The last day can't be before the first day." };
      gmail(true);
      const ws = workspace(args.accountId);
      const saved = {
        ...r,
        subject: r.subject.trim(),
        onlyDomain: ws && r.onlyDomain,
        workspace: ws,
      };
      responders.set(args.accountId, saved);
      return { ...saved };
    },
    end_vacation_responder: (args): VacationResponder => {
      gmail(true);
      const ended = { ...of(args.accountId), enabled: false };
      responders.set(args.accountId, ended);
      return { ...ended };
    },
  } satisfies PartialHandlers;
}
