/** Recipient suggestions for browser preview, from the fixture mail (`src-tauri/src/contacts.rs` in the app). */

import type { ContactSuggestion, GoogleContactsStatus } from "../lib/tauri";
import type { FixtureThread } from "./fixtures";

type Args = Record<string, unknown> | undefined;

/** A few saved Google Contacts for each preview account. */
const GOOGLE_CONTACTS: ContactSuggestion[] = [
  { name: "Grace Hopper", address: "grace@example.net" },
  { name: "Linus Pauling", address: "linus@example.net" },
];

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * `googleContacts`: the status Settings › Contacts shows (`?contacts=missing_scope`, `api_disabled` or `error`;
 * `on` by default, which also adds {@link GOOGLE_CONTACTS} to the suggestions).
 */
export function createContactHandlers(
  threads: FixtureThread[],
  emailOf: (accountId: string) => string | undefined,
  googleContacts: string | null,
) {
  let status = (googleContacts ?? "on") as GoogleContactsStatus["status"];
  const statusOf = (): GoogleContactsStatus => ({
    status,
    message: status === "error" ? "Gmail API error 500: Backend Error" : null,
    enableUrl:
      status === "api_disabled"
        ? "https://console.cloud.google.com/apis/library/people.googleapis.com"
        : null,
    count: status === "on" ? GOOGLE_CONTACTS.length : 0,
    syncedAt: status === "on" ? Date.now() - 60 * 60_000 : null,
  });

  const people = (accountId: string) => {
    const own = emailOf(accountId)?.toLowerCase();
    const scores = new Map<string, { name: string | null; score: number }>();
    const add = (address: string, name: string | null, weight: number) => {
      const key = address.toLowerCase();
      if (key === own) return;
      const seen = scores.get(key);
      scores.set(key, { name: seen?.name ?? name, score: (seen?.score ?? 0) + weight });
    };
    for (const t of threads.filter((f) => f.accountId === accountId))
      for (const m of t.messages) {
        const sent = m.fromAddress.toLowerCase() === own;
        if (!sent) add(m.fromAddress, m.fromName || null, 1);
        for (const r of [...m.to, ...m.cc]) add(r.address, r.name, sent ? 10 : 1);
      }
    if (status === "on") for (const c of GOOGLE_CONTACTS) add(c.address, c.name, 8);
    return [...scores].map(([address, { name, score }]) => ({ address, name, score }));
  };

  return {
    suggest_contacts: (args: Args): ContactSuggestion[] => {
      const query = String(args?.query ?? "")
        .trim()
        .toLowerCase();
      if (!query) return [];
      const asked = query.split(/\s+/);
      return people(String(args?.accountId))
        .filter((p) => {
          const own = [...words(p.name ?? ""), ...words(p.address), ...p.address.split("@")];
          return (
            p.address.startsWith(query) || asked.every((q) => own.some((w) => w.startsWith(q)))
          );
        })
        .sort((a, b) => b.score - a.score || a.address.localeCompare(b.address))
        .slice(0, Number(args?.limit) || 8)
        .map(({ name, address }) => ({ name, address }));
    },
    google_contacts_status: (): GoogleContactsStatus => statusOf(),
    refresh_google_contacts: (): GoogleContactsStatus => {
      // Checking again after turning the API on succeeds; a missing permission needs a sign-in.
      if (status === "api_disabled" || status === "error") status = "on";
      return statusOf();
    },
  };
}
