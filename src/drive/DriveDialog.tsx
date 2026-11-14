import { Check, File, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/Button";
import { DetailDialog } from "../components/ui/DetailDialog";
import { Skeleton } from "../components/ui/Skeleton";
import { TextInput } from "../components/ui/TextInput";
import { toast } from "../components/ui/Toast";
import {
  type AttachmentInfo,
  type CommandError,
  openExternal,
  openMailLink,
  toCommandError,
} from "../lib/tauri";
import { formatSize } from "../mail/AttachmentList";
import { useSignIn } from "../onboarding/useSignIn";
import { useAccountStore } from "../store/accountStore";
import {
  type DriveFile,
  type DrivePage,
  driveFiles,
  driveFileUrl,
  saveAttachmentToDrive,
} from "./api";

const DRIVE_API_URL = "https://console.cloud.google.com/apis/library/drive.googleapis.com";
// Recent listings render at once when the picker reopens. Bound memory and isolate accounts/queries.
const listings = new Map<string, DrivePage>();

type Props = { accountId: string; onClose(): void } & (
  | { onPick(files: DriveFile[]): void; attachment?: never; messageId?: never }
  | { onPick?: never; attachment: AttachmentInfo; messageId: string }
);

export function DriveDialog(props: Props) {
  const { accountId, onClose } = props;
  const savingAttachment = props.attachment !== undefined;
  const account = useAccountStore((s) => s.accounts.find((a) => a.id === accountId));
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [retry, setRetry] = useState(0);
  const cacheKey = JSON.stringify([accountId, search]);
  const [result, setResult] = useState<{
    key: string;
    page: DrivePage | null;
    error: CommandError | null;
  } | null>(null);
  const [saveError, setSaveError] = useState<CommandError | null>(null);
  const [paging, setPaging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<DriveFile[]>([]);
  const { state, start, cancel } = useSignIn();
  const connected = state.phase === "connected";
  const requestKey = JSON.stringify([cacheKey, retry, connected]);
  const page = result?.key === requestKey ? result.page : (listings.get(cacheKey) ?? null);
  const error = saveError ?? (result?.key === requestKey ? result.error : null);
  const loading = result?.key !== requestKey || paging;
  const request = useRef<AbortController | null>(null);
  const operation = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    void driveFiles(accountId, search).then(
      (result) => {
        if (controller.signal.aborted) return;
        if (listings.size >= 30) listings.delete(listings.keys().next().value!);
        listings.set(cacheKey, result);
        setResult({ key: requestKey, page: result, error: null });
      },
      (e) => {
        if (!controller.signal.aborted)
          setResult({
            key: requestKey,
            page: listings.get(cacheKey) ?? null,
            error: toCommandError(e),
          });
      },
    );
    return () => controller.abort();
  }, [accountId, cacheKey, search, requestKey]);

  const more = async () => {
    if (!page?.nextPageToken || loading) return;
    const current = request.current;
    setPaging(true);
    try {
      const next = await driveFiles(accountId, search, page.nextPageToken);
      if (current?.signal.aborted) return;
      const merged = {
        ...next,
        files: [...page.files, ...next.files.filter((f) => !page.files.some((p) => p.id === f.id))],
      };
      setResult({ key: requestKey, page: merged, error: null });
      listings.set(cacheKey, merged);
    } catch (e) {
      if (!current?.signal.aborted) setResult({ key: requestKey, page, error: toCommandError(e) });
    } finally {
      setPaging(false);
    }
  };

  const save = async () => {
    if (!savingAttachment || operation.current || !props.attachment) return;
    operation.current = true;
    setBusy(true);
    setSaveError(null);
    try {
      const file = await saveAttachmentToDrive(accountId, props.messageId, props.attachment.id);
      listings.clear();
      toast({
        title: "Saved to My Drive",
        description: file.name,
        action: {
          label: "Open in Drive",
          run: () =>
            void openMailLink(driveFileUrl(file)).catch((e) =>
              toast({
                title: "Couldn't open Drive",
                description: toCommandError(e).message,
                tone: "danger",
              }),
            ),
        },
      });
      operation.current = false;
      onClose();
    } catch (e) {
      setSaveError(toCommandError(e));
    } finally {
      operation.current = false;
      setBusy(false);
    }
  };

  const allow = error?.code === "missing_scope";
  const disabled = error?.code === "api_disabled";
  const failed = state.phase === "failed" ? state.error : null;
  const authorizing = state.phase === "authorizing";
  const ready = !!page && !allow && !disabled;
  const close = () => {
    if (!operation.current) onClose();
  };

  return (
    <DetailDialog
      title={savingAttachment ? "Save to Google Drive" : "Attach from Google Drive"}
      onClose={close}
    >
      <p className="detail-dialog__note">{account?.email ?? "Google Drive"}</p>
      {savingAttachment ? (
        <p className="detail-dialog__note">
          Save {props.attachment?.filename ?? "this attachment"} to My Drive. You can move it into a
          folder in Drive afterward.
        </p>
      ) : (
        <TextInput
          leading={<Search />}
          aria-label="Search Drive files"
          placeholder="Search Drive files"
          data-autofocus=""
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={busy}
        />
      )}
      <div className="detail-dialog__body" aria-busy={loading || busy}>
        {allow || disabled ? (
          <>
            <p className="detail-dialog__note">
              {allow
                ? "Connect Drive to find files and save attachments. Pheeme can see file names and details, and create new files."
                : error.message}
            </p>
            {allow ? (
              <Button
                onClick={() => {
                  setSaveError(null);
                  void start({ kind: "drive", accountId });
                }}
                disabled={authorizing}
              >
                {authorizing ? "Finish in your browser…" : "Allow Drive access"}
              </Button>
            ) : (
              <Button
                onClick={() =>
                  void openExternal(DRIVE_API_URL).catch((e) => setSaveError(toCommandError(e)))
                }
              >
                Turn on the Drive API
              </Button>
            )}
            {authorizing && (
              <Button variant="ghost" onClick={cancel}>
                Cancel sign-in
              </Button>
            )}
          </>
        ) : savingAttachment ? (
          <p className="detail-dialog__note">
            {ready
              ? "The saved file will use your Drive's default sharing permissions."
              : loading
                ? "Checking Drive access…"
                : "Drive is unavailable."}
          </p>
        ) : !page && loading ? (
          Array.from({ length: 6 }, (_, i) => (
            <div className="detail-dialog__row" key={i}>
              <Skeleton width="80%" />
            </div>
          ))
        ) : (
          <>
            {page?.files.map((file) => {
              const picked = selected.some((s) => s.id === file.id);
              return (
                <button
                  key={file.id}
                  type="button"
                  className="detail-dialog__row"
                  aria-pressed={picked}
                  onClick={() =>
                    setSelected((all) =>
                      picked ? all.filter((s) => s.id !== file.id) : [...all, file],
                    )
                  }
                >
                  <File aria-hidden="true" />
                  <span className="detail-dialog__row-text">
                    <span className="detail-dialog__row-name">{file.name}</span>
                    <span className="detail-dialog__note">
                      {file.size !== null ? formatSize(Number(file.size)) : "Google document"}
                    </span>
                  </span>
                  {picked && <Check aria-hidden="true" />}
                </button>
              );
            })}
            {page?.files.length === 0 && !loading && (
              <p className="detail-dialog__note">
                {search ? "No files match this search." : "No files in Drive yet."}
              </p>
            )}
            {page?.nextPageToken && (
              <Button disabled={loading} onClick={() => void more()}>
                {loading ? "Loading…" : "Load more"}
              </Button>
            )}
          </>
        )}
      </div>
      <p className="detail-dialog__error" role="alert">
        {failed?.message ?? (!allow && !disabled && error ? error.message : "")}
      </p>
      {!savingAttachment && (
        <p className="detail-dialog__note">
          Files are inserted as links. Recipients need access in Drive; sharing permissions stay as
          they are.
        </p>
      )}
      <div className="detail-dialog__actions">
        {error && !allow && (
          <Button
            disabled={busy || loading}
            onClick={() => {
              setSaveError(null);
              setRetry((n) => n + 1);
            }}
          >
            Check again
          </Button>
        )}
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        {savingAttachment ? (
          <Button
            variant="primary"
            disabled={!ready || loading || busy || authorizing || !!error}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save to My Drive"}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={!selected.length || !ready || authorizing}
            onClick={() => {
              props.onPick?.(selected);
              onClose();
            }}
          >
            Insert {selected.length || ""} {selected.length === 1 ? "link" : "links"}
          </Button>
        )}
      </div>
    </DetailDialog>
  );
}
