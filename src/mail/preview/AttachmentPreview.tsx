import { ChevronLeft, ChevronRight, Download, ExternalLink, File, X } from "lucide-react";
import {
  type KeyboardEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { isEditableTarget, registry } from "../../keyboard/registry";
import { type AttachmentInfo, toCommandError } from "../../lib/tauri";
import { formatSize } from "../AttachmentList";
import { downloadAttachment, openAttachmentExternally } from "../attachmentActions";
import { attachmentBytes } from "./bytes";
import { canOpenExternally, previewKind, type PreviewKind } from "./kinds";
import { type PreviewSession, usePreviewStore } from "./previewStore";
import { PreviewMessage } from "./PreviewMessage";
import "./preview.css";

// The heavy readers load the first time a file of their kind is opened.
const PdfView = lazy(() => import("./PdfView"));
const DocxView = lazy(() => import("./DocxView"));
const SheetView = lazy(() => import("./SheetView"));
const PptxView = lazy(() => import("./PptxView"));

/** Plain text past this is cut off in the preview. */
const MAX_TEXT_BYTES = 1024 * 1024;

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The attachment preview over the blurred app. Mount once, inside the mail screen. */
export function AttachmentPreview() {
  const session = usePreviewStore((s) => s.session);
  if (!session) return null;
  return <PreviewPanel session={session} />;
}

/** A finished read, for the file whose key it carries; anything else on screen is still loading. */
type Loaded =
  | { key: string; state: "ready"; data: ArrayBuffer }
  | { key: string; state: "failed"; message: string };

const nameOf = (file: AttachmentInfo) => file.filename ?? "Attachment";

function PreviewPanel({ session }: { session: PreviewSession }) {
  const { accountId, messageId, files, index } = session;
  const file = files[index];
  const kind = previewKind(file.filename, file.mimeType);
  const name = nameOf(file);
  const close = usePreviewStore((s) => s.close);
  const step = usePreviewStore((s) => s.step);
  const fileKey = `${accountId}/${messageId}/${file.id}`;
  const [result, setResult] = useState<Loaded | null>(null);
  const loaded = result?.key === fileKey ? result : { state: "loading" as const };
  const [returnFocus] = useState(() => document.activeElement as HTMLElement | null);
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  // While the panel is open, keys belong to it: mail shortcuts would act on the app behind. (Not a
  // `data-owns-keys` region: that would make every key inside look like typing to the handler below.)
  useEffect(() => registry.suspend(), []);

  useEffect(() => {
    stageRef.current?.focus({ preventScroll: true });
    return () => returnFocus?.focus?.({ preventScroll: true });
  }, [returnFocus]);

  useEffect(() => {
    if (kind === "other") return;
    const stop = new AbortController();
    attachmentBytes(accountId, messageId, file.id).then(
      (data) => !stop.signal.aborted && setResult({ key: fileKey, state: "ready", data }),
      (e) =>
        !stop.signal.aborted &&
        setResult({ key: fileKey, state: "failed", message: toCommandError(e).message }),
    );
    // Warm the neighbours, so flipping is instant.
    for (const d of [1, -1]) {
      const other = files[(index + d + files.length) % files.length];
      if (files.length > 1 && previewKind(other.filename, other.mimeType) !== "other")
        attachmentBytes(accountId, messageId, other.id).catch(() => undefined);
    }
    return () => {
      stop.abort();
    };
  }, [accountId, messageId, file.id, files, index, kind, fileKey]);

  const download = async () => {
    setSaving(true);
    try {
      await downloadAttachment(accountId, messageId, file);
    } finally {
      setSaving(false);
    }
  };

  const refocus = useCallback(() => stageRef.current?.focus({ preventScroll: true }), []);

  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (isEditableTarget(e.target)) {
        return;
      } else if (e.key === " ") {
        // Quick Look's toggle: Space opened it, Space closes it.
        e.preventDefault();
        close();
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        step(e.key === "ArrowRight" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, step]);

  // Keep Tab inside the panel.
  const trapTab = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === stageRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const openable = canOpenExternally(file.filename);
  const many = files.length > 1;

  return (
    <div
      className="file-preview-scrim"
      onPointerDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        ref={dialogRef}
        className="file-preview"
        role="dialog"
        aria-modal="true"
        aria-label={`Preview: ${name}`}
        onKeyDown={trapTab}
      >
        <header className="file-preview__header">
          <div className="file-preview__title">
            <h2 className="file-preview__name" title={name}>
              {name}
            </h2>
            <span className="file-preview__meta">
              {[
                file.size != null && formatSize(file.size),
                many && `${index + 1} of ${files.length}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
          {many && (
            <div className="file-preview__nav">
              <IconButton
                label="Previous attachment"
                shortcut="left"
                icon={<ChevronLeft />}
                onClick={() => step(-1)}
              />
              <IconButton
                label="Next attachment"
                shortcut="right"
                icon={<ChevronRight />}
                onClick={() => step(1)}
              />
            </div>
          )}
          {openable && (
            <Button
              size="sm"
              icon={<ExternalLink />}
              title="Open in your default app"
              onClick={() => void openAttachmentExternally(accountId, messageId, file)}
            >
              Open
            </Button>
          )}
          <Button
            size="sm"
            icon={<Download />}
            disabled={saving}
            aria-busy={saving}
            onClick={() => void download()}
          >
            {saving ? "Saving…" : "Download"}
          </Button>
          <IconButton label="Close preview" shortcut="esc" icon={<X />} onClick={close} />
        </header>
        <div
          ref={stageRef}
          className={`file-preview__stage file-preview__stage--${kind}`}
          tabIndex={-1}
        >
          {kind === "other" ? (
            <NoPreview file={file} openable={openable} />
          ) : loaded.state === "loading" ? (
            <PreviewMessage busy>Loading “{name}”…</PreviewMessage>
          ) : loaded.state === "failed" ? (
            <PreviewMessage>
              Couldn't load “{name}”: {loaded.message}
            </PreviewMessage>
          ) : (
            <Suspense fallback={<PreviewMessage busy>Opening…</PreviewMessage>}>
              <FileBody
                key={fileKey}
                kind={kind}
                data={loaded.data}
                file={file}
                onFrameFocus={refocus}
              />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}

function FileBody({
  kind,
  data,
  file,
  onFrameFocus,
}: {
  kind: Exclude<PreviewKind, "other">;
  data: ArrayBuffer;
  file: AttachmentInfo;
  onFrameFocus(): void;
}) {
  const name = nameOf(file);
  switch (kind) {
    case "pdf":
      return <PdfView data={data} name={name} />;
    case "docx":
      return <DocxView data={data} name={name} onFrameFocus={onFrameFocus} />;
    case "pptx":
      return <PptxView data={data} name={name} />;
    case "xlsx":
    case "csv":
      return <SheetView data={data} kind={kind} name={name} />;
    case "image":
      return <ImageView data={data} file={file} />;
    case "text":
      return <TextView data={data} />;
  }
}

function ImageView({ data, file }: { data: ArrayBuffer; file: AttachmentInfo }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // A data: URL, so there's no blob: URL to revoke.
  useEffect(() => {
    const stop = new AbortController();
    const reader = new FileReader();
    reader.onload = () => !stop.signal.aborted && setUrl(String(reader.result));
    reader.onerror = () => !stop.signal.aborted && setFailed(true);
    const type = /\.svg$/i.test(file.filename ?? "")
      ? "image/svg+xml"
      : (file.mimeType ?? "application/octet-stream");
    reader.readAsDataURL(new Blob([data], { type }));
    return () => {
      stop.abort();
    };
  }, [data, file.filename, file.mimeType]);

  if (failed) return <PreviewMessage>Couldn't show this image.</PreviewMessage>;
  if (!url) return <PreviewMessage busy>Opening…</PreviewMessage>;
  return (
    <img
      className="file-preview__image"
      src={url}
      alt={nameOf(file)}
      onError={() => setFailed(true)}
    />
  );
}

function TextView({ data }: { data: ArrayBuffer }) {
  const cut = data.byteLength > MAX_TEXT_BYTES;
  const text = new TextDecoder().decode(cut ? data.slice(0, MAX_TEXT_BYTES) : data);
  return (
    <pre className="file-preview__text selectable">
      {text}
      {cut && "\n\n… (the rest of the file isn't shown)"}
    </pre>
  );
}

function NoPreview({ file, openable }: { file: AttachmentInfo; openable: boolean }) {
  return (
    <div className="file-preview__none">
      <File className="file-preview__none-icon" aria-hidden="true" />
      <p className="file-preview__none-name">{nameOf(file)}</p>
      <p className="file-preview__none-hint">
        {openable
          ? "Pheeme can't preview this kind of file. Open it in its app, or download it."
          : "Pheeme can't preview this kind of file. Download it to open it."}
      </p>
    </div>
  );
}
