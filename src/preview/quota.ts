import type { QuotaMinute, QuotaUsage } from "../lib/tauri";

const MINUTE_MS = 60_000;

/** The same small "random" wobble for the same minute and seed, so the chart doesn't jump. */
function wobble(minute: number, seed: number, spread: number) {
  const x = Math.sin(minute * 12.9898 + seed * 78.233) * 43758.5453;
  return Math.floor((x - Math.floor(x)) * spread);
}

/**
 * A realistic last hour of one account's Gmail quota: sync checking for mail every 10 s, a burst of
 * the older-mail download 50 to 41 minutes ago, a few queued changes and things the user opened, an
 * assistant's search for the first account, and (also for the first account) Gmail refusing two
 * requests 12 minutes ago while this copy of Pheeme used little: something else spent the quota.
 */
export function previewQuotaUsage(
  accountId: string,
  limitPerMinute: number,
  now = Date.now(),
): QuotaUsage {
  const first = accountId === "acc-personal";
  const current = Math.floor(now / MINUTE_MS);
  const minutes: QuotaMinute[] = Array.from({ length: 60 }, (_, i) => {
    const ago = 59 - i;
    const minute = current - ago;
    const units = {
      newMail: 12 + wobble(minute, 1, 4) * 5,
      olderMail: ago >= 41 && ago <= 50 ? (first ? 2_000 : 1_400) + wobble(minute, 2, 350) : 0,
      yourChanges: [3, 17, 28, 44].includes(ago) ? 50 + wobble(minute, 3, 3) * 50 : 0,
      youAsked: ago % 7 === 2 ? 10 + wobble(minute, 4, 6) * 10 : 0,
      assistants: first && (ago === 8 || ago === 9) ? 150 + wobble(minute, 5, 150) : 0,
    };
    return { startMs: minute * MINUTE_MS, units, refused: first && ago === 12 ? 2 : 0 };
  });
  return { limitPerMinute, minutes };
}
