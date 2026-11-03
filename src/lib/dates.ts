/**
 * List timestamps the way mail clients do: time today, weekday this week,
 * day and month this year, full date before that. Locale-aware.
 */
export function formatListDate(ts: number, now: number = Date.now(), locale?: string): string {
  const d = new Date(ts);
  const n = new Date(now);
  const startOfToday = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  if (ts >= startOfToday)
    return d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  if (ts >= startOfToday - 6 * 86_400_000)
    return d.toLocaleDateString(locale, { weekday: "short" });
  if (d.getFullYear() === n.getFullYear())
    return d.toLocaleDateString(locale, { month: "short", day: "numeric" });
  return d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

/** Header timestamp in the reading pane. */
export function formatFullDate(ts: number, locale?: string): string {
  return new Date(ts).toLocaleString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
