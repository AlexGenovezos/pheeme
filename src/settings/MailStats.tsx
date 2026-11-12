// Settings › Mail stats: how much mail arrives each day, where it lands, how much of it you engage
// with (open, reply to or star), and who sends the most, with Unsubscribe beside each sender.
// Counted from the mail on this computer (`mail_stats`); nothing goes to Gmail but an unsubscribe.
import { Info } from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { Button } from "../components/ui/Button";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { Select } from "../components/ui/Select";
import { Skeleton } from "../components/ui/Skeleton";
import { toast } from "../components/ui/Toast";
import { useComposeStore } from "../compose/composeStore";
import {
  getMailStats,
  type InboxTab,
  type MailCounts,
  type MailStats,
  type PlaceStats,
  type SenderStats,
  toCommandError,
  unsubscribeSender,
} from "../lib/tauri";
import { openLink } from "../mail/linkify";
import { useAccountStore } from "../store/accountStore";
import { useSettingsStore } from "./settingsStore";

export const RANGES = ["7", "30", "90", "365"] as const;
export type Range = (typeof RANGES)[number];
const RANGE_LABELS: Record<Range, string> = {
  "7": "7 days",
  "30": "30 days",
  "90": "90 days",
  "365": "1 year",
};
const ALL = "all";
/** Rows drawn while loading, so the first frame has the shape of the answer. */
const PENDING_LABELS = 3;
const PENDING_SENDERS = 8;

const TAB_NAMES: Record<InboxTab, string> = {
  primary: "Primary",
  promotions: "Promotions",
  social: "Social",
  updates: "Updates",
  forums: "Forums",
  spam: "Spam",
};

/** A local `YYYY-MM-DD`, as the backend names days. */
export const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Local midnight `days - 1` days before `now`: the window covers today and the days before it. */
export function windowStart(days: number, now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
}

export interface Bucket {
  /** The first day in it. */
  start: Date;
  /** How many days it covers (7 for a week, less for the last one). */
  length: number;
  received: number;
  engaged: number;
}

/**
 * One bar per day of the window, or per week for a year (365 bars would be hairlines). Days
 * without mail are empty bars, so the axis is time.
 */
export function buckets(stats: Pick<MailStats, "days"> | null, start: Date, days: number) {
  const byDay = new Map(stats?.days.map((d) => [d.day, d]));
  const size = days > 90 ? 7 : 1;
  const out: Bucket[] = [];
  for (let i = 0; i < days; i += size) {
    const first = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const bucket: Bucket = {
      start: first,
      length: Math.min(size, days - i),
      received: 0,
      engaged: 0,
    };
    for (let j = 0; j < bucket.length; j++) {
      const day = new Date(first.getFullYear(), first.getMonth(), first.getDate() + j);
      const d = byDay.get(dayKey(day));
      bucket.received += d?.received ?? 0;
      bucket.engaged += d?.engaged ?? 0;
    }
    out.push(bucket);
  }
  return out;
}

const count = (n: number) => n.toLocaleString();

/** A share as a whole percent ("<1%" for a sliver), or a dash when there's nothing to share. */
export function percent(part: number, whole: number): string {
  if (whole <= 0) return "–";
  const share = (part / whole) * 100;
  return share > 0 && share < 1 ? "<1%" : `${Math.round(share)}%`;
}

/** `n` over `days`, per `per` days: whole numbers from 10 up, one decimal below. */
export function rate(n: number, days: number, per = 1): string {
  const value = (n / days) * per;
  if (value === 0) return "0";
  if (value < 0.1) return "<0.1";
  return value >= 10 ? count(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

const shortDate = (d: Date) => d.toLocaleDateString([], { month: "short", day: "numeric" });

/** The address and the fields Pheeme can fill in from a `mailto:` link. */
export function parseMailto(url: string): { to: string; subject: string; body: string } | null {
  if (!/^mailto:/i.test(url)) return null;
  const [path, query = ""] = url.slice("mailto:".length).split("?", 2);
  const params = new URLSearchParams(query);
  const to = decodeURIComponent(path).split(",")[0]?.trim() || params.get("to") || "";
  if (!to) return null;
  return {
    to,
    subject: params.get("subject") ?? "unsubscribe",
    body: params.get("body") ?? "",
  };
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

type SenderState = "busy" | "done" | "opened";
/** Senders unsubscribed from this session, so switching pages doesn't offer it again. */
const handled = new Map<string, SenderState>();
const senderKey = (s: Pick<SenderStats, "accountId" | "sender">) => `${s.accountId}\n${s.sender}`;

export function MailStatsSettings() {
  const accounts = useAccountStore((s) => s.accounts);
  const [range, setRange] = useState<Range>("30");
  const [account, setAccount] = useState<string>(ALL);
  // Each answer and failure is kept with the question it answers, so a stale one never shows.
  const [answer, setAnswer] = useState<{ key: string; stats: MailStats } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const days = Number(range);
  // Recomputed on each change of range or account, so a page left open over midnight catches up.
  const [start, setStart] = useState(() => windowStart(days));
  // An account removed while chosen falls back to all of them.
  const chosen = accounts.some((a) => a.id === account) ? account : ALL;
  const key = `${chosen}|${start.getTime()}|${attempt}`;
  const stats = answer?.key === key ? answer.stats : null;
  const error = failure?.key === key ? failure.message : null;

  useEffect(() => {
    let live = true;
    getMailStats(chosen === ALL ? null : chosen, start.getTime()).then(
      (value) => {
        if (live) setAnswer({ key, stats: value });
      },
      (raw: unknown) => {
        if (live) setFailure({ key, message: toCommandError(raw).message });
      },
    );
    return () => {
      live = false;
    };
  }, [chosen, start, key]);

  const choose = (next: { range?: Range; account?: string }) => {
    const r = next.range ?? range;
    setRange(r);
    if (next.account !== undefined) setAccount(next.account);
    setStart(windowStart(Number(r)));
  };

  if (accounts.length === 0) return <p className="settings-empty">No accounts connected.</p>;

  return (
    <div className="settings-stats">
      <div className="settings-stats__filters">
        <SegmentedControl
          label="Time range"
          value={range}
          options={RANGES.map((r) => ({ value: r, label: RANGE_LABELS[r] }))}
          onChange={(r) => choose({ range: r })}
        />
        {accounts.length > 1 && (
          <Select
            aria-label="Account"
            value={chosen}
            options={[
              { value: ALL, label: "All accounts" },
              ...accounts.map((a) => ({ value: a.id, label: a.email })),
            ]}
            onChange={(a) => choose({ account: a })}
          />
        )}
      </div>

      {error ? (
        <div className="settings-stats__note" role="alert">
          <Info aria-hidden />
          <span>Couldn't count your mail: {error}</span>
          <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </div>
      ) : (
        <p className="settings-stats__note">
          <Info aria-hidden />
          <span>
            {stats && !stats.complete
              ? "Older mail is still downloading, so earlier days may count low."
              : "Counted from the mail on this computer. Opened means read anywhere, on any device."}
          </span>
        </p>
      )}

      <Tiles totals={stats?.totals ?? null} days={days} />
      <DailyChart stats={stats} start={start} days={days} />
      <Places stats={stats} days={days} />
      <Senders stats={stats} days={days} />
    </div>
  );
}

function Tiles({ totals, days }: { totals: MailCounts | null; days: number }) {
  const tiles: { label: string; value: (t: MailCounts) => string }[] = [
    { label: "received a day", value: (t) => rate(t.received, days) },
    { label: "opened", value: (t) => percent(t.opened, t.received) },
    { label: "replied to", value: (t) => percent(t.replied, t.received) },
    { label: "starred", value: (t) => percent(t.starred, t.received) },
  ];
  return (
    <div className="settings-stats__tiles">
      {tiles.map((tile) => (
        <div key={tile.label} className="settings-stats__tile">
          <span className="settings-stats__tile-value">
            {totals ? tile.value(totals) : <Skeleton width="3ch" />}
          </span>
          <span className="settings-stats__tile-label">{tile.label}</span>
        </div>
      ))}
    </div>
  );
}

/** One colour of a stacked bar, sized by `size` against its sibling; empty parts take no room. */
function Part({
  tag: Tag,
  kind,
  size,
}: {
  tag: "div" | "span";
  kind: "engaged" | "rest";
  size: number;
}) {
  return (
    <Tag
      className="settings-stats__part"
      data-part={kind}
      data-empty={size <= 0 || undefined}
      style={{ flexGrow: Math.max(0, size) }}
    />
  );
}

function DailyChart({
  stats,
  start,
  days,
}: {
  stats: MailStats | null;
  start: Date;
  days: number;
}) {
  const [active, setActive] = useState<number | null>(null);
  const bars = buckets(stats, start, days);
  const weekly = bars[0]?.length === 7;
  const top = Math.max(1, ...bars.map((b) => b.received));
  const total = stats?.totals.received ?? 0;
  const shown = active === null ? null : bars[active];
  const when = (b: Bucket) => (weekly ? `Week of ${shortDate(b.start)}` : shortDate(b.start));

  function onKeyDown(e: KeyboardEvent) {
    const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (!step) return;
    e.preventDefault();
    setActive((i) => Math.min(bars.length - 1, Math.max(0, (i ?? bars.length - 1) + step)));
  }

  return (
    <section className="settings-stats__section" aria-label="Received over time">
      <div className="settings-stats__heading">
        <h3>{weekly ? "Received each week" : "Received each day"}</h3>
        <span className="settings-stats__detail">
          {!stats ? (
            <Skeleton width="22ch" />
          ) : shown ? (
            `${when(shown)}: ${count(shown.received)} received, ${count(shown.engaged)} engaged`
          ) : (
            `${count(total)} emails in ${days} days`
          )}
        </span>
      </div>
      <div className="settings-stats__legend">
        <span>
          <i className="settings-stats__swatch" data-part="engaged" />
          Engaged (opened, replied or starred)
        </span>
        <span>
          <i className="settings-stats__swatch" data-part="rest" />
          Never opened
        </span>
      </div>
      <div
        className="settings-stats__plot"
        role="img"
        tabIndex={0}
        aria-label={
          stats
            ? `${count(total)} emails received in the last ${days} days, ${percent(stats.totals.engaged, total)} engaged. Use the arrow keys to read each ${weekly ? "week" : "day"}.`
            : "Mail received over time, loading"
        }
        onKeyDown={onKeyDown}
        onFocus={() => setActive((i) => i ?? bars.length - 1)}
        onBlur={() => setActive(null)}
        onMouseLeave={() => setActive(null)}
      >
        {bars.map((b, i) => (
          <div
            key={b.start.getTime()}
            className="settings-stats__column"
            data-active={active === i || undefined}
            onMouseEnter={() => setActive(i)}
          >
            <div
              className="settings-stats__stack"
              style={{ height: `${(b.received / top) * 100}%` }}
            >
              <Part tag="div" kind="engaged" size={b.engaged} />
              <Part tag="div" kind="rest" size={b.received - b.engaged} />
            </div>
          </div>
        ))}
      </div>
      <div className="settings-stats__axis" aria-hidden>
        <span>{shortDate(bars[0].start)}</span>
        <span>{shortDate(bars[Math.floor(bars.length / 2)].start)}</span>
        <span>Today</span>
      </div>
    </section>
  );
}

function PlaceRow({
  name,
  place,
  days,
  top,
}: {
  /** Known before the counts for an inbox tab; a label's comes with them. */
  name: string | null;
  place: PlaceStats | null;
  days: number;
  top: number;
}) {
  return (
    <div className="settings-stats__place">
      <span className="settings-stats__place-name">{name ?? <Skeleton width="9ch" />}</span>
      <span
        className="settings-stats__meter"
        title={place ? `${count(place.received)} received, ${count(place.engaged)} engaged` : ""}
      >
        <span
          className="settings-stats__meter-fill"
          style={{ width: `${place ? (place.received / top) * 100 : 0}%` }}
        >
          <Part tag="span" kind="engaged" size={place?.engaged ?? 0} />
          <Part tag="span" kind="rest" size={place ? place.received - place.engaged : 0} />
        </span>
      </span>
      <span className="settings-stats__num">
        {place ? rate(place.received, days) : <Skeleton width="3ch" />}
      </span>
      <span className="settings-stats__num">
        {place ? percent(place.opened, place.received) : <Skeleton width="3ch" />}
      </span>
    </div>
  );
}

function PlaceHeader({ title }: { title: string }) {
  return (
    <div className="settings-stats__place settings-stats__place--head" aria-hidden>
      <span>{title}</span>
      <span />
      <span className="settings-stats__num">a day</span>
      <span className="settings-stats__num">opened</span>
    </div>
  );
}

function Places({ stats, days }: { stats: MailStats | null; days: number }) {
  const tabs = (Object.keys(TAB_NAMES) as InboxTab[]).map((id) => ({
    id,
    name: TAB_NAMES[id],
    place: stats?.tabs.find((t) => t.id === id) ?? null,
  }));
  const labels: (PlaceStats | null)[] =
    stats?.labels ?? Array.from({ length: PENDING_LABELS }, () => null);
  const top = Math.max(
    1,
    ...(stats ? [...stats.tabs, ...stats.labels] : []).map((p) => p.received),
  );
  return (
    <section className="settings-stats__section" aria-label="Where it lands">
      <div className="settings-stats__heading">
        <h3>Where it lands</h3>
      </div>
      <div className="settings-stats__places">
        <PlaceHeader title="Inbox tab" />
        {tabs.map((t) => (
          <PlaceRow key={t.id} name={t.name} place={t.place} days={days} top={top} />
        ))}
        {labels.length > 0 && <PlaceHeader title="Label" />}
        {labels.map((p, i) => (
          <PlaceRow key={p?.id ?? i} name={p?.name ?? null} place={p} days={days} top={top} />
        ))}
      </div>
    </section>
  );
}

function Senders({ stats, days }: { stats: MailStats | null; days: number }) {
  const rows: (SenderStats | null)[] =
    stats?.senders ?? Array.from({ length: PENDING_SENDERS }, () => null);
  return (
    <section className="settings-stats__section" aria-label="Top senders">
      <div className="settings-stats__heading">
        <h3>Top senders</h3>
      </div>
      {stats && rows.length === 0 ? (
        <p className="settings-stats__empty">No mail received in these {days} days.</p>
      ) : (
        <table className="settings-stats__senders">
          <thead>
            <tr>
              <th scope="col">Sender</th>
              <th scope="col">Lands in</th>
              <th scope="col" className="settings-stats__num">
                a week
              </th>
              <th scope="col" className="settings-stats__num">
                opened
              </th>
              <th scope="col" className="settings-stats__num">
                replied
              </th>
              <th scope="col">
                <span className="settings-stats__sr">Unsubscribe</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s, i) => (
              <SenderRow key={s ? senderKey(s) : i} sender={s} days={days} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function SenderRow({ sender: s, days }: { sender: SenderStats | null; days: number }) {
  return (
    <tr>
      <td className="settings-stats__who">
        <span className="settings-stats__who-name">
          {s ? s.name || s.sender : <Skeleton width="14ch" />}
        </span>
        <span className="settings-stats__who-address">
          {s ? s.name ? s.sender : "" : <Skeleton width="20ch" />}
        </span>
      </td>
      <td>
        {s ? (
          <span className="settings-stats__tab">{TAB_NAMES[s.tab] ?? s.tab}</span>
        ) : (
          <Skeleton width="8ch" />
        )}
      </td>
      <td className="settings-stats__num">
        {s ? rate(s.received, days, 7) : <Skeleton width="3ch" />}
      </td>
      <td className="settings-stats__num">
        {s ? percent(s.opened, s.received) : <Skeleton width="3ch" />}
      </td>
      <td className="settings-stats__num">{s ? count(s.replied) : <Skeleton width="2ch" />}</td>
      <td className="settings-stats__action">
        {s ? <UnsubscribeButton sender={s} /> : <Skeleton width="10ch" />}
      </td>
    </tr>
  );
}

function UnsubscribeButton({ sender }: { sender: SenderStats }) {
  const key = senderKey(sender);
  const [state, setState] = useState<SenderState | undefined>(() => handled.get(key));
  const who = sender.name || sender.sender;
  const mark = (next: SenderState | undefined) => {
    if (next) handled.set(key, next);
    else handled.delete(key);
    setState(next);
  };

  if (sender.unsubscribe === "none" || !sender.threadId) {
    return (
      <span
        className="settings-stats__no-unsubscribe"
        title="This sender's mail has no unsubscribe link. A sender rule or filter can file it instead."
      >
        No unsubscribe
      </span>
    );
  }
  if (state === "done" || state === "opened") {
    return (
      <span className="settings-stats__no-unsubscribe">
        {state === "done" ? "Unsubscribed" : "Opened"}
      </span>
    );
  }

  async function unsubscribe() {
    mark("busy");
    try {
      const result = await unsubscribeSender(sender.accountId, sender.threadId!);
      if (result.unsubscribed) {
        mark("done");
        toast({
          title: `Unsubscribed from ${who}`,
          description: "Some lists take a few days to stop.",
        });
      } else if (result.web) {
        mark("opened");
        openLink(result.web);
        toast({
          title: `Opened ${who}'s unsubscribe page`,
          description: "Finish there to stop their mail.",
        });
      } else if (result.mailto && parseMailto(result.mailto)) {
        const mail = parseMailto(result.mailto)!;
        mark("opened");
        useComposeStore.getState().compose(sender.accountId, {
          to: [{ name: null, address: mail.to }],
          subject: mail.subject,
          bodyHtml: mail.body ? `<p>${escapeHtml(mail.body)}</p>` : "",
        });
        useSettingsStore.getState().close();
        toast({
          title: `${who} unsubscribes by email`,
          description: "Send the message that just opened to stop their mail.",
        });
      } else {
        mark(undefined);
        toast({
          title: `${who} doesn't offer unsubscribing`,
          description: "A sender rule or filter can file their mail instead.",
        });
      }
    } catch (raw) {
      mark(undefined);
      toast({
        title: `Couldn't unsubscribe from ${who}`,
        description: toCommandError(raw).message,
        tone: "danger",
      });
    }
  }

  return (
    <Button
      size="sm"
      disabled={state === "busy"}
      aria-label={`Unsubscribe from ${who}`}
      onClick={() => void unsubscribe()}
    >
      Unsubscribe
    </Button>
  );
}

export function __resetUnsubscribedForTests() {
  handled.clear();
}
