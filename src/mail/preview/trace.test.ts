import { expect, it } from "vitest";
import type { PreviewReport } from "../../lib/tauri";
import { PreviewTrace } from "./trace";

function setup(kind = "pdf") {
  let now = 0;
  const reports: PreviewReport[] = [];
  const trace = new PreviewTrace(
    kind,
    125_181,
    (r) => reports.push(r),
    () => now,
    2,
  );
  return {
    trace,
    reports,
    at(ms: number) {
      now = ms;
    },
  };
}

it("reports a drawn PDF with its timings, once", () => {
  const s = setup();
  s.at(40);
  s.trace.loaded();
  s.at(90);
  s.trace.read(3);
  s.at(150);
  s.trace.drew(1, false, { width: 1600, height: 2070 });
  s.trace.drew(2, false, { width: 1600, height: 2070 });
  s.at(2000);
  s.trace.finish();
  s.trace.finish();
  expect(s.reports).toEqual([
    {
      kind: "pdf",
      bytes: 125_181,
      outcome: "shown",
      loadMs: 40,
      readMs: 90,
      shownMs: 150,
      pages: 3,
      drawn: 2,
      blank: 0,
      canvas: "1600x2070",
      firstPage: "drawn",
      pixelRatio: 2,
      errors: 0,
      error: null,
      totalMs: 2000,
    },
  ]);
});

it("names what went wrong", () => {
  const outcome = (fn: (t: PreviewTrace) => void) => {
    const s = setup();
    fn(s.trace);
    s.trace.finish();
    return s.reports[0];
  };
  expect(outcome((t) => t.failed("load", "Gmail is unreachable"))).toMatchObject({
    outcome: "load_failed",
    error: "load: Gmail is unreachable",
  });
  const pdfError = Object.assign(new Error("Invalid PDF structure."), {
    name: "InvalidPDFException",
  });
  expect(
    outcome((t) => {
      t.loaded();
      t.failed("read", pdfError);
    }),
  ).toMatchObject({
    outcome: "read_failed",
    error: expect.stringMatching(/^read: InvalidPDFException: Invalid PDF structure\. \| at /),
  });
  expect(
    outcome((t) => {
      t.read(2);
      t.failed("render", new Error("canvas too large"));
      t.failed("render", new Error("again"));
    }),
  ).toMatchObject({ outcome: "render_failed", errors: 2 });
  expect(
    outcome((t) => {
      t.read(2);
      t.drew(1, true);
      t.drew(2, true);
    }),
  ).toMatchObject({ outcome: "blank", drawn: 2, blank: 2 });
  expect(outcome((t) => t.read(3))).toMatchObject({ outcome: "not_drawn", drawn: 0 });
  expect(outcome((t) => t.loaded())).toMatchObject({ outcome: "left" });
});

it("keeps a reader's own message out, since it can quote the file", () => {
  const s = setup("xlsx");
  s.trace.failed("read", new TypeError('Unrecognized cell "Salary: 92,000"'));
  s.trace.finish();
  expect(s.reports[0].error).toMatch(/^read: TypeError \| at /);
  expect(s.reports[0].error).not.toContain("Salary");
});

it("a blank first page reads as blank even when a later page has content", () => {
  const s = setup();
  s.trace.drew(2, false);
  s.trace.drew(1, true);
  s.trace.finish();
  expect(s.reports[0]).toMatchObject({ outcome: "blank", firstPage: "blank", drawn: 2, blank: 1 });
  const unread = setup();
  unread.trace.drew(1, null);
  unread.trace.finish();
  expect(unread.reports[0]).toMatchObject({ outcome: "shown", firstPage: "unknown" });
});

it("a page redrawn with content stops counting as blank", () => {
  const s = setup();
  s.trace.drew(1, true);
  s.trace.drew(1, false);
  s.trace.finish();
  expect(s.reports[0]).toMatchObject({ outcome: "shown", drawn: 1, blank: 0 });
});
