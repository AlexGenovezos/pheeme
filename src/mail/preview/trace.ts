import { createContext, useContext } from "react";
import type { PreviewReport } from "../../lib/tauri";
import { describe as describeError } from "../../lib/windowProblems";

/**
 * Follows one attachment preview from opening to closing and reports, once, how it went
 * (`log_preview`): how long the bytes and the reader took, how many pages were drawn, whether they
 * came out blank, and the first failure. A reader that swallows its own errors ("Couldn't read …")
 * or draws nothing would otherwise leave no trace in a diagnostics report.
 */
export class PreviewTrace {
  private readonly start: number;
  private loadMs: number | null = null;
  private readMs: number | null = null;
  private shownMs: number | null = null;
  private pages: number | null = null;
  private drawnPages = new Set<number>();
  private blankPages = new Set<number>();
  private canvas: string | null = null;
  private errors = 0;
  private firstError: { stage: Stage; text: string } | null = null;
  private done = false;

  constructor(
    private readonly kind: string,
    private readonly bytes: number | null,
    private readonly report: (report: PreviewReport) => void,
    private readonly now: () => number = () => performance.now(),
    private readonly pixelRatio: number = globalThis.devicePixelRatio || 1,
  ) {
    this.start = now();
  }

  private elapsed() {
    return Math.round(this.now() - this.start);
  }

  /** The file's bytes are in hand. */
  loaded() {
    this.loadMs ??= this.elapsed();
  }

  /** The reader parsed the file; `pages` when it counts them. */
  read(pages?: number) {
    this.readMs ??= this.elapsed();
    if (pages != null) this.pages = pages;
  }

  /** Page `page` (1-based) was drawn on `canvas`; `blank` when it came out a single colour. */
  drew(page: number, blank: boolean, canvas?: { width: number; height: number }) {
    this.shownMs ??= this.elapsed();
    if (canvas && this.canvas == null) this.canvas = `${canvas.width}x${canvas.height}`;
    this.drawnPages.add(page);
    if (blank) this.blankPages.add(page);
    else this.blankPages.delete(page);
  }

  /** A reader without pages showed the whole file. */
  shown() {
    this.read();
    this.drew(1, false);
  }

  failed(stage: Stage, error: unknown) {
    this.errors += 1;
    this.firstError ??= { stage, text: describeError(error) };
  }

  /** The preview closed or moved to another file: report it. Later calls do nothing. */
  finish() {
    if (this.done) return;
    this.done = true;
    this.report({
      kind: this.kind,
      bytes: this.bytes,
      outcome: this.outcome(),
      loadMs: this.loadMs,
      readMs: this.readMs,
      shownMs: this.shownMs,
      pages: this.pages,
      drawn: this.drawnPages.size,
      blank: this.blankPages.size,
      canvas: this.canvas,
      pixelRatio: this.pixelRatio,
      errors: this.errors,
      error: this.firstError && `${this.firstError.stage}: ${this.firstError.text}`,
      totalMs: this.elapsed(),
    });
  }

  private outcome(): PreviewReport["outcome"] {
    const drawn = this.drawnPages.size;
    if (drawn > 0) return this.blankPages.size === drawn ? "blank" : "shown";
    switch (this.firstError?.stage) {
      case "load":
        return "load_failed";
      case "read":
        return "read_failed";
      case "render":
        return "render_failed";
    }
    return this.readMs == null ? "left" : "not_drawn";
  }
}

/** Where a failure happened: fetching the bytes, parsing them, or drawing a page. */
export type Stage = "load" | "read" | "render";

/** Side of the tiny copy a drawn page is shrunk to before its pixels are read. */
const SAMPLE = 24;

/**
 * Whether `canvas` holds a single colour (all white, or nothing drawn). Shrinks it to a 24×24 copy
 * first, so reading the pixels stays cheap whatever the page size. Unknown (false) when the pixels
 * can't be read.
 */
export function isBlankCanvas(canvas: HTMLCanvasElement): boolean {
  if (!canvas.width || !canvas.height) return true;
  try {
    const sample = document.createElement("canvas");
    sample.width = SAMPLE;
    sample.height = SAMPLE;
    const ctx = sample.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(canvas, 0, 0, SAMPLE, SAMPLE);
    const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);
    for (let i = 4; i < data.length; i += 4) {
      if (
        data[i] !== data[0] ||
        data[i + 1] !== data[1] ||
        data[i + 2] !== data[2] ||
        data[i + 3] !== data[3]
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** The open file's trace, for the reader showing it. */
export const PreviewTraceContext = createContext<PreviewTrace | null>(null);

export const usePreviewTrace = () => useContext(PreviewTraceContext);
