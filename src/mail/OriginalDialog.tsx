import { Copy, Download } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/Button";
import { DetailDialog } from "../components/ui/DetailDialog";
import { Skeleton } from "../components/ui/Skeleton";
import { toast } from "../components/ui/Toast";
import { formatFullDate } from "../lib/dates";
import {
  type AuthResult,
  type CommandError,
  messageOriginal,
  type OriginalMessage,
  toCommandError,
} from "../lib/tauri";
import { closeOriginal, downloadOriginal, useOriginalStore } from "./original";
import "./original.css";

const CHECKS = [
  ["spf", "SPF"],
  ["dkim", "DKIM"],
  ["dmarc", "DMARC"],
] as const;

type Loaded = { key: string; original: OriginalMessage | null; error: CommandError | null };

/** pass is good, fail and softfail are bad, anything else (neutral, none, temperror…) is just reported. */
const tone = (result: string) =>
  result === "pass" ? "pass" : result === "fail" || result === "softfail" ? "fail" : "other";

/** Mounted once: the dialog for the message `useOriginalStore` names. */
export function OriginalHost() {
  const open = useOriginalStore((s) => s.open);
  return open ? (
    <OriginalDialog
      key={`${open.accountId}:${open.messageId}`}
      accountId={open.accountId}
      messageId={open.messageId}
    />
  ) : null;
}

/** One line whatever Gmail reported (several DKIM signatures are common): every result, the first one's
 *  explanation, and all the explanations as the tooltip. */
function AuthValue({ results }: { results: AuthResult[] }) {
  if (results.length === 0) return <span className="original__muted">Not reported</span>;
  const details = results.flatMap((r) => (r.detail ? [r.detail] : []));
  return (
    <div className="original__auth" title={details.join("\n")}>
      {results.map((r, i) => (
        <span key={i} className={`original__result original__result--${tone(r.result)}`}>
          {r.result.toUpperCase()}
        </span>
      ))}
      {details[0] && <span className="original__detail">{details[0]}</span>}
    </div>
  );
}

function OriginalDialog({ accountId, messageId }: { accountId: string; messageId: string }) {
  const [attempt, setAttempt] = useState(0);
  const requestKey = `${accountId}:${messageId}:${attempt}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [saving, setSaving] = useState(false);
  const done = loaded?.key === requestKey;
  const original = done ? loaded.original : null;
  const error = done ? loaded.error : null;

  useEffect(() => {
    let live = true;
    void messageOriginal(accountId, messageId).then(
      (o) => live && setLoaded({ key: requestKey, original: o, error: null }),
      (e) => live && setLoaded({ key: requestKey, original: null, error: toCommandError(e) }),
    );
    return () => {
      live = false;
    };
  }, [accountId, messageId, requestKey]);

  // A source cut for display is fetched in full for the clipboard. The text goes in as a promise, so the
  // copy still counts as the click's (WebKit refuses a write that waits for the network first).
  const copy = () => {
    if (!original) return;
    // WebKit reports a failed fetch inside the write as a permission error, so keep the real one.
    let fetchError: unknown;
    const text = original.truncated
      ? messageOriginal(accountId, messageId, true).then(
          (o) => o.source,
          (e) => {
            fetchError = e;
            throw e;
          },
        )
      : Promise.resolve(original.source);
    const copied =
      typeof ClipboardItem === "undefined"
        ? text.then((t) => navigator.clipboard.writeText(t))
        : navigator.clipboard.write([
            new ClipboardItem({
              "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })),
            }),
          ]);
    void copied.then(
      () => toast({ title: "Copied to clipboard" }),
      (e) => {
        const cause = fetchError ?? e;
        toast({
          title: "Couldn't copy the source",
          description:
            typeof cause === "object" && cause && "code" in cause
              ? toCommandError(cause).message
              : undefined,
          tone: "danger",
        });
      },
    );
  };

  const download = async () => {
    setSaving(true);
    try {
      await downloadOriginal(accountId, messageId);
    } finally {
      setSaving(false);
    }
  };

  const text = (value: string | null | undefined) =>
    !done ? (
      <Skeleton width="60%" />
    ) : value ? (
      <span className="selectable" title={value}>
        {value}
      </span>
    ) : (
      <span className="original__muted">—</span>
    );

  return (
    <DetailDialog title="Original message" onClose={closeOriginal}>
      <div className="detail-dialog__body original" aria-busy={!done}>
        <dl className="original__summary">
          <dt>Message ID</dt>
          <dd>{text(original?.messageId)}</dd>
          <dt>Created at</dt>
          <dd>{text(original?.createdAt != null ? formatFullDate(original.createdAt) : null)}</dd>
          <dt>From</dt>
          <dd>{text(original?.from)}</dd>
          <dt>To</dt>
          <dd>{text(original?.to)}</dd>
          <dt>Subject</dt>
          <dd>{text(original?.subject)}</dd>
          {CHECKS.map(([method, label]) => (
            <div key={method} className="original__check">
              <dt>{label}</dt>
              <dd>
                {done && original ? (
                  <AuthValue results={original.auth.filter((a) => a.method === method)} />
                ) : (
                  text(null)
                )}
              </dd>
            </div>
          ))}
        </dl>
        <div className="original__actions">
          <Button
            icon={<Download />}
            disabled={!original || saving}
            onClick={() => void download()}
          >
            Download original
          </Button>
          <Button icon={<Copy />} disabled={!original} onClick={copy}>
            Copy to clipboard
          </Button>
          <span className="detail-dialog__note original__size">
            {original?.truncated
              ? "Showing the first 1 MB. Download original and Copy have all of it."
              : " "}
          </span>
        </div>
        {error ? (
          <div className="original__failed" role="alert">
            <p className="detail-dialog__error">{error.message}</p>
            <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </div>
        ) : (
          <pre className="original__source selectable" aria-label="Message source">
            {original ? original.source : " "}
          </pre>
        )}
      </div>
    </DetailDialog>
  );
}
