/** Recipient suggestions for browser preview, from the fixture mail (`src-tauri/src/contacts.rs` in the app). */

import type { ContactSuggestion, GoogleContactsStatus } from "../lib/tauri";
import type { FixtureThread } from "./fixtures";
import type { PersonProfile } from "../contacts/api";

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
  const saved = new Map<string, Map<string, string | null>>();
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
    for (const [address, name] of saved.get(accountId) ?? []) add(address, name, 8);
    return [...scores].map(([address, { name, score }]) => ({ address, name, score }));
  };

  return {
    person_profile: (args: Args): PersonProfile => {
      const accountId = String(args?.accountId);
      const address = String(args?.address).trim().toLowerCase();
      const contact = people(accountId).find((p) => p.address === address);
      const conversations = threads
        .filter(
          (t) =>
            t.accountId === accountId &&
            !t.labelIds.some((l) => ["SPAM", "TRASH", "DRAFT"].includes(l)) &&
            t.messages.some((m) =>
              [m.fromAddress, ...m.to.map((a) => a.address), ...m.cc.map((a) => a.address)].some(
                (a) => a.toLowerCase() === address,
              ),
            ),
        )
        .map((t) => ({
          id: t.id,
          subject: t.subject,
          snippet: t.messages[t.messages.length - 1]?.bodyText ?? null,
          date: t.messages[t.messages.length - 1]?.date ?? 0,
        }))
        .sort((a, b) => b.date - a.date)
        .slice(0, 8);
      return {
        address,
        name: contact?.name ?? null,
        saved:
          (status === "on" && GOOGLE_CONTACTS.some((c) => c.address === address)) ||
          !!saved.get(accountId)?.has(address),
        conversations,
        events: [],
        calendarAvailable: true,
      };
    },
    save_person_contact: (args: Args) => {
      const accountId = String(args?.accountId);
      if (status === "api_disabled")
        throw {
          code: "api_disabled",
          message: "Turn on the People API in your Google Cloud project.",
        };
      const list = saved.get(accountId) ?? new Map<string, string | null>();
      list.set(
        String(args?.address).toLowerCase(),
        typeof args?.name === "string" ? args.name : null,
      );
      saved.set(accountId, list);
    },
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
