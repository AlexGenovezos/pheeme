// Each account's "Send mail as" addresses: its own and the verified aliases Gmail sends from, with each one's
// Gmail signature. Kept from the last fetch so the From picker and an alias's signature are there at once,
// offline too; fetched again once a session.
import { create } from "zustand";
import { type EmailAddress, type SendAsAddress, sendAsAddresses } from "../lib/tauri";

const KEY = "pheeme.send-as";

function storage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

const isAddress = (v: unknown): v is SendAsAddress =>
  !!v &&
  typeof v === "object" &&
  typeof (v as SendAsAddress).email === "string" &&
  typeof (v as SendAsAddress).isPrimary === "boolean" &&
  typeof (v as SendAsAddress).isDefault === "boolean";

function read(): Record<string, SendAsAddress[]> {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, SendAsAddress[]> = {};
    for (const [id, list] of Object.entries(parsed))
      if (Array.isArray(list)) out[id] = list.filter(isAddress);
    return out;
  } catch {
    return {};
  }
}

export const sameAddress = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** A send-as entry as a From address. */
export const asFrom = (a: SendAsAddress): EmailAddress => ({ name: a.name, address: a.email });

interface SendAsState {
  /** Per account, from the last fetch; missing until one succeeds. */
  lists: Record<string, SendAsAddress[]>;
  /** Fetch the account's addresses again. Failures keep what's known. */
  refresh(accountId: string): Promise<void>;
  /** Fetch them once per session. */
  refreshOnce(accountId: string): Promise<void>;
  /** Where a new message from the account starts: Gmail's default send-as address, `null` while unknown. */
  defaultFrom(accountId: string): EmailAddress | null;
}

const inflight = new Map<string, Promise<void>>();
const fetched = new Set<string>();

export const useSendAs = create<SendAsState>((set, get) => ({
  lists: read(),

  refresh(accountId) {
    const running = inflight.get(accountId);
    if (running) return running;
    fetched.add(accountId);
    const run = sendAsAddresses(accountId)
      .then((list) => {
        if (!Array.isArray(list)) return;
        const lists = { ...get().lists, [accountId]: list };
        set({ lists });
        try {
          storage()?.setItem(KEY, JSON.stringify(lists));
        } catch {
          // Kept until the app closes.
        }
      })
      .catch(() => {})
      .finally(() => inflight.delete(accountId));
    inflight.set(accountId, run);
    return run;
  },

  refreshOnce(accountId) {
    if (fetched.has(accountId)) return inflight.get(accountId) ?? Promise.resolve();
    return get().refresh(accountId);
  },

  defaultFrom(accountId) {
    const list = get().lists[accountId];
    const pick = list?.find((a) => a.isDefault) ?? list?.find((a) => a.isPrimary);
    return pick ? asFrom(pick) : null;
  },
}));

/** Test helper: re-read what's stored. */
export function __resetSendAsForTests() {
  inflight.clear();
  fetched.clear();
  useSendAs.setState({ lists: read() });
}
