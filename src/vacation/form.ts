// The vacation responder form's model: what the fields hold, from and to Gmail's responder.
import type { VacationResponder } from "../lib/tauri";
import { dateOf, endOfDate, lastDateOf, startOfDate } from "./dates";

export interface VacationForm {
  enabled: boolean;
  /** `YYYY-MM-DD`. */
  firstDay: string;
  /** Whether it has a last day ("Ends"). */
  ends: boolean;
  /** `YYYY-MM-DD`; kept while `ends` is off, so ticking it again brings it back. */
  lastDay: string;
  subject: string;
  html: string;
  onlyContacts: boolean;
  onlyDomain: boolean;
}

/** The form for Gmail's responder; a responder with no first day starts today, as Gmail shows it. */
export function formOf(r: VacationResponder, now = Date.now()): VacationForm {
  const firstDay = dateOf(r.startMs ?? now);
  return {
    enabled: r.enabled,
    firstDay,
    ends: r.endMs !== null,
    lastDay: r.endMs !== null ? lastDateOf(r.endMs) : firstDay,
    subject: r.subject,
    html: r.html,
    onlyContacts: r.onlyContacts,
    onlyDomain: r.onlyDomain,
  };
}

/** What to save to Gmail. */
export function responderOf(form: VacationForm, workspace: boolean): VacationResponder {
  return {
    enabled: form.enabled,
    subject: form.subject.trim(),
    html: form.html,
    onlyContacts: form.onlyContacts,
    onlyDomain: workspace && form.onlyDomain,
    startMs: startOfDate(form.firstDay),
    endMs: form.ends ? endOfDate(form.lastDay) : null,
    workspace,
  };
}

/** Why the form can't be saved, or `null`. */
export function formProblem(form: VacationForm): string | null {
  if (form.ends && form.lastDay < form.firstDay)
    return "The last day can't be before the first day.";
  return null;
}

export const sameForm = (a: VacationForm, b: VacationForm) =>
  (Object.keys(a) as (keyof VacationForm)[]).every((k) => a[k] === b[k]);
