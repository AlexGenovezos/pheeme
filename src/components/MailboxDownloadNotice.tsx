import { useShallow } from "zustand/react/shallow";
import { useSettingsStore } from "../settings/settingsStore";
import { useAccountStore } from "../store/accountStore";
import { currentDownload, useDownloadStore } from "../store/downloadStore";
import { CornerCard } from "./ui/CornerCard";
import "./MailboxDownloadNotice.css";

/**
 * Pinned in the bottom-right corner while a mailbox downloads (an account's first sync and the backfill
 * after it): how far along it is, and that the app can be used meanwhile. Every line is drawn in every
 * state, so the card keeps its size as numbers arrive and when it turns into "Mailbox downloaded".
 */
export function MailboxDownloadNotice() {
  const state = useDownloadStore();
  const { finished, dismiss } = state;
  const { summary, open } = currentDownload(state);
  const accounts = useAccountStore((s) => s.accounts);
  const slowed = useAccountStore(useShallow((s) => Object.keys(s.slowSync)));
  if (!open && !finished) return null;

  let title: string;
  let percent: string;
  let value: number | undefined;
  let count: string;
  let note: string;
  if (summary && open) {
    title = "Downloading your mailbox";
    percent = summary.percent === null ? "" : `${summary.percent}%`;
    value = summary.percent ?? undefined;
    const counted =
      summary.total === null
        ? `${summary.synced.toLocaleString()} messages · Counting mail…`
        : `${summary.synced.toLocaleString()} of ${summary.total.toLocaleString()} messages`;
    const who =
      summary.accountIds.length === 1
        ? accounts.find((a) => a.id === summary.accountIds[0])?.email
        : `${summary.accountIds.length} accounts`;
    count = who ? `${counted} · ${who}` : counted;
    const unfinished = state.progress!.filter((p) => !p.complete).map((p) => p.accountId);
    note = unfinished.some((id) => slowed.includes(id))
      ? "Gmail is slowing the download. It carries on by itself."
      : "You can keep using Pheeme meanwhile.";
  } else {
    title = "Mailbox downloaded";
    percent = "100%";
    value = 100;
    count = `${finished!.total.toLocaleString()} messages`;
    note = "Recent mail is available offline.";
  }

  return (
    <CornerCard
      className="mailbox-download"
      // Details opens Settings: the card steps aside rather than cover the dialog.
      waits
      title={
        <>
          <span>{title}</span>
          <span className="mailbox-download__percent">{percent}</span>
        </>
      }
      onDismiss={dismiss}
    >
      <progress
        className="mailbox-download__bar"
        aria-label="Mailbox download"
        aria-valuetext={count}
        max={100}
        value={value}
      />
      <span className="ui-toast__description mailbox-download__line" title={count}>
        {count}
      </span>
      <div className="mailbox-download__footer">
        <span className="ui-toast__description mailbox-download__line" title={note}>
          {note}
        </span>
        <button
          type="button"
          className="ui-toast__action"
          onClick={() => useSettingsStore.getState().openSettings("accounts")}
        >
          Details
        </button>
      </div>
    </CornerCard>
  );
}
