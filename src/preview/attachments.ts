import { previewKind } from "../mail/preview/kinds";

// `new URL(…, import.meta.url)` is Vite's way to ship a file as an asset and get its URL.
const SAMPLES: Record<string, string> = {
  pdf: new URL("./files/sample.pdf", import.meta.url).href,
  image: new URL("./files/sample.png", import.meta.url).href,
  docx: new URL("./files/sample.docx", import.meta.url).href,
  xlsx: new URL("./files/sample.xlsx", import.meta.url).href,
  pptx: new URL("./files/sample.pptx", import.meta.url).href,
  csv: new URL("./files/sample.csv", import.meta.url).href,
};

/** The bytes the browser preview serves for an attachment: a real sample file of its kind. */
export async function sampleAttachment(
  filename: string | null,
  mimeType: string | null,
): Promise<ArrayBuffer> {
  const kind = previewKind(filename, mimeType);
  const url = SAMPLES[kind];
  if (kind === "text" || !url)
    return new TextEncoder().encode(`Sample ${filename ?? "file"}\n`).buffer;
  return (await fetch(url)).arrayBuffer();
}
