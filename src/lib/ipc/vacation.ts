import { call } from "./call";

/** An account's vacation responder, as Gmail has it (`users.settings.vacation`). */
export interface VacationResponder {
  enabled: boolean;
  subject: string;
  /** The message as HTML; "" for none. */
  html: string;
  onlyContacts: boolean;
  /** Only for Workspace accounts; always `false` for a personal one. */
  onlyDomain: boolean;
  /** When it starts replying (epoch ms); `null`: as soon as it's on. */
  startMs: number | null;
  /** It replies only to mail received before this (epoch ms); `null`: until it's turned off. */
  endMs: number | null;
  /** A Workspace account, which can limit replies to its domain. Ignored when saving. */
  workspace: boolean;
}

/** Read from Gmail. Rejects with `missing_scope` when the account hasn't allowed its basic mail settings. */
export const getVacationResponder = (accountId: string) =>
  call("get_vacation_responder", { accountId });
/** Replace the responder in Gmail; resolves to what Gmail saved. */
export const setVacationResponder = (accountId: string, responder: VacationResponder) =>
  call("set_vacation_responder", { accountId, responder });
/** Gmail's End now: off, with the rest kept as Gmail has it. */
export const endVacationResponder = (accountId: string) =>
  call("end_vacation_responder", { accountId });
