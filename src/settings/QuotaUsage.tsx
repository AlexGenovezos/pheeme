import { Info } from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { Skeleton } from "../components/ui/Skeleton";
import {
  getGmailQuotaUsage,
  type QuotaMinute,
  type QuotaSource,
  type QuotaUsage,
} from "../lib/tauri";

/** How often the open Accounts page asks again. */
export const QUOTA_REFRESH_MS = 10_000;

/**
 * What spends the quota, in the chart's fixed order (bottom of each bar first); each has its own
 * colour token (`--quota-*` in tokens.css).
 */
export const QUOTA_SOURCES: { id: QuotaSource; label: string; detail: string; color: string }[] = [
  {
    id: "newMail",
    label: "Checking for new mail",
    detail: "Sync of new mail and changes made elsewhere",
    color: "var(--quota-new-mail)",
  },
  {
    id: "olderMail",
    label: "Downloading older mail",
    detail: "The mailbox download running in the background",
    color: "var(--quota-older-mail)",
  },
  {
    id: "yourChanges",
    label: "Sending your changes",
    detail: "Archive, read, labels, trash and sends waiting for Gmail",
    color: "var(--quota-your-changes)",
  },
  {
    id: "youAsked",
    label: "Opening and searching",
    detail: "Opening mail, searches, attachments, drafts, labels and filters",
    color: "var(--quota-you-asked)",
  },
  {
    id: "assistants",
    label: "AI assistants",
    detail: "Calls made for AI assistants through MCP",
    color: "var(--quota-assistants)",
  },
];

export const minuteTotal = (m: QuotaMinute) =>
  QUOTA_SOURCES.reduce((sum, s) => sum + m.units[s.id], 0);

export interface QuotaSummary {
  totals: Record<QuotaSource, number>;
  total: number;
  /** The busiest minute's units. */
  peak: number;
  refused: number;
  /**
   * Gmail refused requests although this Pheeme couldn't have reached the limit on its own:
   * Gmail's minute can straddle two of ours, so the refused minute and the one before it
   * together stayed under the limit.
   */
  somethingElse: boolean;
}

export function summarizeQuota(usage: QuotaUsage): QuotaSummary {
  const totals = Object.fromEntries(QUOTA_SOURCES.map((s) => [s.id, 0])) as Record<
    QuotaSource,
    number
  >;
  let peak = 0;
  let refused = 0;
  let somethingElse = false;
  let before = 0;
  for (const minute of usage.minutes) {
    for (const s of QUOTA_SOURCES) totals[s.id] += minute.units[s.id];
    const total = minuteTotal(minute);
    peak = Math.max(peak, total);
    refused += minute.refused;
    if (minute.refused > 0 && before + total < usage.limitPerMinute) somethingElse = true;
    before = total;
  }
  const total = QUOTA_SOURCES.reduce((sum, s) => sum + totals[s.id], 0);
  return { totals, total, peak, refused, somethingElse };
}

/** The account's usage, asked again every [`QUOTA_REFRESH_MS`] while mounted; never overlapping. */
export function useQuotaUsage(accountId: string) {
  const [usage, setUsage] = useState<QuotaUsage | null>(null);
  useEffect(() => {
    let stopped = false;
    const timer: { id?: ReturnType<typeof setTimeout> } = {};
    async function refresh() {
      try {
        const value = await getGmailQuotaUsage(accountId);
        if (!stopped) setUsage(value);
      } catch {
        // Keep the last answer; the next refresh tries again.
      } finally {
        if (!stopped) timer.id = setTimeout(() => void refresh(), QUOTA_REFRESH_MS);
      }
    }
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer.id);
    };
  }, [accountId]);
  return usage;
}

const MINUTES = 60;
/** The share of the plot's height the larger of the limit and the busiest minute takes. */
const HEADROOM = 0.85;
const count = (n: number) => n.toLocaleString();
const time = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const percent = (part: number, whole: number) => {
  const share = (part / whole) * 100;
  return share > 0 && share < 1 ? "<1%" : `${Math.round(share)}%`;
};

export function GmailQuotaUsage({ accountId, email }: { accountId: string; email: string }) {
  return <QuotaUsageChart email={email} usage={useQuotaUsage(accountId)} />;
}

/**
 * "Gmail quota, last hour": per-minute stacked bars by source under the limit line, a legend
 * with each source's total, and what Gmail refused. Before `usage` arrives every line and slot is
 * already there (skeletons), so nothing moves when it does.
 */
export function QuotaUsageChart({ email, usage }: { email: string; usage: QuotaUsage | null }) {
  const [active, setActive] = useState<number | null>(null);
  const summary = usage && summarizeQuota(usage);
  const limit = usage?.limitPerMinute ?? 0;
  // The limit is always in view, so a low bar reads as "well under it", with headroom above the
  // line for its label.
  const top = (Math.max(limit, summary?.peak ?? 0) || 1) / HEADROOM;
  const minutes = usage?.minutes ?? [];
  const slots = Array.from({ length: MINUTES }, (_, i) => minutes[i] ?? null);
  const shown = active === null ? null : slots[active];

  function onKeyDown(e: KeyboardEvent) {
    const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (!step) return;
    e.preventDefault();
    setActive((i) => Math.min(MINUTES - 1, Math.max(0, (i ?? MINUTES - 1) + step)));
  }

  return (
    <div className="settings-sync settings-usage">
      <div className="settings-sync__heading">
        <span>Gmail quota, last hour</span>
        <span className="settings-usage__peak">
          {summary ? (
            `Busiest minute ${count(summary.peak)} of ${count(limit)}`
          ) : (
            <Skeleton className="settings-sync__pending" width="20ch" />
          )}
        </span>
      </div>
      <div
        className="settings-usage__plot"
        role="img"
        tabIndex={0}
        aria-label={
          summary
            ? `Gmail quota units for ${email} in each of the last 60 minutes, against a limit of ${count(limit)} a minute. Busiest minute ${count(summary.peak)}. Use the arrow keys to read each minute.`
            : `Gmail quota for ${email}, loading`
        }
        onKeyDown={onKeyDown}
        onFocus={() => setActive((i) => i ?? MINUTES - 1)}
        onBlur={() => setActive(null)}
        onMouseLeave={() => setActive(null)}
      >
        <div
          className="settings-usage__limit"
          style={{ bottom: `${(usage ? limit / top : HEADROOM) * 100}%` }}
        >
          <span>{usage ? `Limit ${count(limit)} a minute` : "Limit"}</span>
        </div>
        <div className="settings-usage__bars">
          {slots.map((minute, i) => (
            <div
              key={i}
              className="settings-usage__minute"
              data-active={active === i || undefined}
              onMouseEnter={() => setActive(i)}
            >
              <div
                className="settings-usage__stack"
                style={{ height: `${minute ? (minuteTotal(minute) / top) * 100 : 0}%` }}
              >
                {QUOTA_SOURCES.filter((s) => minute && minute.units[s.id] > 0).map((s) => (
                  <span
                    key={s.id}
                    className="settings-usage__part"
                    data-source={s.id}
                    style={{ flexGrow: minute?.units[s.id], background: s.color }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        {shown && active !== null && (
          <QuotaTooltip minute={shown} limit={limit} right={active >= MINUTES / 2} index={active} />
        )}
      </div>
      <div className="settings-usage__marks" aria-hidden="true">
        {slots.map((minute, i) => (
          <span key={i} className="settings-usage__mark">
            {minute && minute.refused > 0 && <span className="settings-usage__refused-dot" />}
          </span>
        ))}
      </div>
      <div className="settings-usage__axis" aria-hidden="true">
        <span>60 min ago</span>
        <span>Now</span>
      </div>
      <ul className="settings-usage__legend" aria-label="Quota used in the last hour">
        {QUOTA_SOURCES.map((s) => (
          <li key={s.id} className="settings-usage__key" title={s.detail}>
            <span className="settings-usage__swatch" style={{ background: s.color }} />
            <span className="settings-usage__key-label">{s.label}</span>
            <span className="settings-usage__key-value">
              {summary ? (
                summary.total > 0 ? (
                  `${count(summary.totals[s.id])} · ${percent(summary.totals[s.id], summary.total)}`
                ) : (
                  "0"
                )
              ) : (
                <Skeleton className="settings-sync__pending" width="9ch" />
              )}
            </span>
          </li>
        ))}
      </ul>
      <span className="settings-sync__detail settings-usage__refusals">
        <span className="settings-usage__refused-dot" aria-hidden="true" />
        {summary ? (
          summary.refused > 0 ? (
            `Gmail refused ${count(summary.refused)} ${summary.refused === 1 ? "request" : "requests"} in the last hour`
          ) : (
            "Gmail refused nothing in the last hour"
          )
        ) : (
          <Skeleton className="settings-sync__pending" width="30ch" />
        )}
      </span>
      {summary?.somethingElse && (
        <p className="settings-usage__note" role="note">
          <Info aria-hidden="true" />
          <span>
            Gmail refused requests while this copy of Pheeme was under its share of the limit. The
            limit is shared by everything signed in to this Gmail account through the same Google
            Cloud client, so something else (Pheeme on another device, or another app) is probably
            using the quota.
          </span>
        </p>
      )}
      <QuotaTable usage={usage} />
    </div>
  );
}

function QuotaTooltip({
  minute,
  limit,
  right,
  index,
}: {
  minute: QuotaMinute;
  limit: number;
  right: boolean;
  index: number;
}) {
  const total = minuteTotal(minute);
  // Anchored at the minute's column, opening away from the nearer edge.
  const edge = right
    ? { right: `${((MINUTES - 1 - index) / MINUTES) * 100}%` }
    : { left: `${(index / MINUTES) * 100}%` };
  return (
    <div className="settings-usage__tooltip" style={edge} aria-hidden="true">
      <div className="settings-usage__tooltip-title">{time(minute.startMs)}</div>
      {QUOTA_SOURCES.filter((s) => minute.units[s.id] > 0).map((s) => (
        <div key={s.id} className="settings-usage__tooltip-row">
          <span className="settings-usage__swatch" style={{ background: s.color }} />
          <span>{s.label}</span>
          <span>{count(minute.units[s.id])}</span>
        </div>
      ))}
      <div className="settings-usage__tooltip-row settings-usage__tooltip-total">
        <span />
        <span>Total</span>
        <span>
          {count(total)} of {count(limit)}
        </span>
      </div>
      {minute.refused > 0 && (
        <div className="settings-usage__tooltip-row">
          <span className="settings-usage__refused-dot" />
          <span>Refused by Gmail</span>
          <span>{count(minute.refused)}</span>
        </div>
      )}
    </div>
  );
}

/** The chart as a table, for screen readers: the minutes anything was sent or refused. */
function QuotaTable({ usage }: { usage: QuotaUsage | null }) {
  const busy = (usage?.minutes ?? []).filter((m) => minuteTotal(m) > 0 || m.refused > 0);
  return (
    <table className="settings-usage__table">
      <caption>Gmail quota units by minute</caption>
      <thead>
        <tr>
          <th scope="col">Minute</th>
          {QUOTA_SOURCES.map((s) => (
            <th key={s.id} scope="col">
              {s.label}
            </th>
          ))}
          <th scope="col">Refused</th>
        </tr>
      </thead>
      <tbody>
        {busy.map((m) => (
          <tr key={m.startMs}>
            <th scope="row">{time(m.startMs)}</th>
            {QUOTA_SOURCES.map((s) => (
              <td key={s.id}>{count(m.units[s.id])}</td>
            ))}
            <td>{count(m.refused)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
