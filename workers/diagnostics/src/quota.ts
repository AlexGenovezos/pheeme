// Daily quotas kept by the `DailyCap` Durable Object. Pure over `KvStorage`, so
// tests run it under plain Node.
//
// Each quota has a global count per UTC day and a count per IP per day. IPs are
// never stored as such: the map is keyed by a truncated SHA-256 of the IP and a
// random salt that lives for the same UTC day and is replaced (with the map)
// when the day changes, so no address can be recovered the next day.

import type { KvStorage, QuotaResult, QuotaState } from "./types";

export interface QuotaLimits {
  /** Slots per UTC day, across all IPs. */
  daily: number;
  /** Slots per UTC day for one IP. */
  perIp: number;
}

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Takes one slot of the quota stored under `key` for `ip`. The per-IP count is
 * checked first, so an IP that is over its share never uses up the global cap.
 * Exact as long as one Durable Object calls it: the read and the write of each
 * storage step have no other await between them, so the input gate keeps
 * concurrent calls from interleaving. */
export async function takeQuotaSlot(
  storage: KvStorage,
  key: string,
  now: Date,
  ip: string,
  limits: QuotaLimits,
): Promise<QuotaResult> {
  const day = utcDay(now);
  const salt = await daySalt(storage, day);
  const who = await hashIp(salt, ip);

  const state = await storage.get<QuotaState>(key);
  const fresh = state?.day === day;
  const count = fresh ? state.count : 0;
  const ips = (fresh && state.ips) || {};
  if ((ips[who] ?? 0) >= limits.perIp) return "ip_limit";
  if (count >= limits.daily) return "global_limit";
  await storage.put(key, {
    day,
    count: count + 1,
    ips: { ...ips, [who]: (ips[who] ?? 0) + 1 },
  } satisfies QuotaState);
  return "ok";
}

async function daySalt(storage: KvStorage, day: string): Promise<string> {
  const saved = await storage.get<{ day: string; value: string }>("salt");
  if (saved?.day === day) return saved.value;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const value = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  await storage.put("salt", { day, value });
  return value;
}

async function hashIp(salt: string, ip: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}|${ip}`));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
