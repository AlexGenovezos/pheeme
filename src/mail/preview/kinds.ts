/**
 * How the preview panel shows an attachment. Mirrors `src-tauri/src/attachment_kind.rs`: the
 * extension decides first, because senders often label every file `application/octet-stream`.
 */
export type PreviewKind = "pdf" | "image" | "text" | "csv" | "docx" | "xlsx" | "pptx" | "other";

const BY_EXTENSION: Record<string, PreviewKind> = {
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  avif: "image",
  svg: "image",
  txt: "text",
  md: "text",
  log: "text",
  json: "text",
  xml: "text",
  csv: "csv",
  tsv: "csv",
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
};

const BY_MIME: Record<string, PreviewKind> = {
  "application/pdf": "pdf",
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "image/bmp": "image",
  "image/avif": "image",
  "text/plain": "text",
  "text/markdown": "text",
  "text/csv": "csv",
  "application/json": "text",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

/** Extensions the backend opens in the default app (`attachment_kind::OPENABLE`). */
const OPENABLE = new Set(
  (
    "pdf png jpg jpeg gif webp bmp avif heic heif tif tiff txt md log csv tsv rtf doc docx xls xlsx " +
    "ppt pptx odt ods odp pages numbers key mp3 m4a wav aac flac ogg mp4 mov m4v webm"
  ).split(" "),
);

/** The lowercased extension of a file name, if it has one. */
export function extension(filename: string | null): string | null {
  const name = filename?.split(/[/\\]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : null;
}

export function previewKind(filename: string | null, mimeType: string | null): PreviewKind {
  const ext = extension(filename);
  if (ext && BY_EXTENSION[ext]) return BY_EXTENSION[ext];
  // A known extension that isn't previewable wins over a hopeful MIME type.
  if (ext && OPENABLE.has(ext)) return "other";
  const mime = (mimeType ?? "").split(";")[0].trim().toLowerCase();
  return BY_MIME[mime] ?? "other";
}

/** Whether the backend will open this file in the default app. */
export function canOpenExternally(filename: string | null): boolean {
  const ext = extension(filename);
  return ext !== null && OPENABLE.has(ext);
}
