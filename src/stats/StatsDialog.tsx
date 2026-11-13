// The Stats window: a large dialog over the blurred app, opened from the sidebar's footer or the
// palette. `Stats / account` on the left, the time range, Refresh and Close on the right, and every
// part of Mail stats below on one scrolling page.
import { RefreshCw, X } from "lucide-react";
import { IconButton } from "../components/ui/IconButton";
import { Modal } from "../components/ui/Modal";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { Select } from "../components/ui/Select";
import {
  ALL,
  DailyChart,
  Places,
  RANGE_LABELS,
  RANGES,
  Senders,
  StatsNote,
  Tiles,
  useMailStats,
} from "./MailStats";
import { useStatsStore } from "./statsStore";
import "./Stats.css";

/** Mount once, inside the mail screen; it renders only while open. */
export function Stats() {
  const open = useStatsStore((s) => s.open);
  return open ? <StatsDialog /> : null;
}

function StatsDialog() {
  const close = useStatsStore((s) => s.close);
  const { accounts, range, account, days, start, stats, error, choose, refresh } = useMailStats();

  const actions = (
    <>
      <span className="stats__crumb-sep" aria-hidden>
        /
      </span>
      {accounts.length > 1 ? (
        <Select
          className="stats__crumb"
          aria-label="Account"
          value={account}
          options={[
            { value: ALL, label: "All accounts" },
            ...accounts.map((a) => ({ value: a.id, label: a.email })),
          ]}
          onChange={(a) => choose({ account: a })}
        />
      ) : (
        <span className="stats__crumb-text">{accounts[0]?.email ?? "No accounts"}</span>
      )}
      <span className="stats__header-spacer" />
      <SegmentedControl
        label="Time range"
        value={range}
        options={RANGES.map((r) => ({ value: r, label: RANGE_LABELS[r] }))}
        onChange={(r) => choose({ range: r })}
      />
      <IconButton label="Refresh" icon={<RefreshCw />} onClick={refresh} />
      <IconButton label="Close" icon={<X />} onClick={close} />
    </>
  );

  return (
    <Modal
      title="Stats"
      titleId="stats-title"
      onClose={close}
      className="stats"
      scrimClassName="stats-scrim"
      titleClassName="stats__title"
      titleActions={actions}
    >
      <div className="stats__body" data-autofocus tabIndex={-1}>
        {accounts.length === 0 ? (
          <p className="stats__empty">No accounts connected.</p>
        ) : (
          <div className="stats__content">
            <StatsNote stats={stats} error={error} onRetry={refresh} />
            <Tiles totals={stats?.totals ?? null} days={days} />
            <DailyChart stats={stats} start={start} days={days} />
            <Places stats={stats} days={days} />
            <Senders stats={stats} days={days} />
          </div>
        )}
      </div>
    </Modal>
  );
}
