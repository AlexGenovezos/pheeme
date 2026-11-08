import readXlsxFile from "read-excel-file/browser";
import { useEffect, useState } from "react";
import { parseDelimited } from "./csv";
import { PreviewMessage } from "./PreviewMessage";

/** Past these the preview shows the top-left corner and says so; the file opens in full elsewhere. */
export const MAX_ROWS = 1000;
export const MAX_COLUMNS = 60;

export interface SheetData {
  name: string;
  rows: string[][];
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    const midnight =
      value.getUTCHours() === 0 && value.getUTCMinutes() === 0 && value.getUTCSeconds() === 0;
    return midnight ? value.toISOString().slice(0, 10) : value.toLocaleString();
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

/** Read an .xlsx workbook, or a CSV/TSV file as one sheet. */
export async function readSheets(
  data: ArrayBuffer,
  kind: "xlsx" | "csv",
  filename: string | null,
): Promise<SheetData[]> {
  if (kind === "csv") {
    const text = new TextDecoder().decode(data);
    return [{ name: "Sheet 1", rows: parseDelimited(text, filename) }];
  }
  const sheets = await readXlsxFile(data);
  return sheets.map((s) => ({ name: s.sheet, rows: s.data.map((row) => row.map(cellText)) }));
}

/** Cells that read as numbers line up on the right, as in a spreadsheet app. */
const NUMERIC = /^[-+(]?[$€£¥]?\d[\d,. ]*%?\)?$/;

/** "A", "B", … "Z", "AA", … */
export function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** A spreadsheet as a plain grid with column letters and row numbers; sheet tabs along the bottom. */
export default function SheetView({
  data,
  kind,
  name,
}: {
  data: ArrayBuffer;
  kind: "xlsx" | "csv";
  name: string;
}) {
  const [sheets, setSheets] = useState<SheetData[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    // Mounted once per file (the panel keys it), so there's no earlier file's state to reset.
    const stop = new AbortController();
    readSheets(data, kind, name).then(
      (s) => !stop.signal.aborted && setSheets(s),
      () => !stop.signal.aborted && setFailed(true),
    );
    return () => {
      stop.abort();
    };
  }, [data, kind, name]);

  if (failed) return <PreviewMessage>Couldn't read “{name}” as a spreadsheet.</PreviewMessage>;
  if (!sheets) return <PreviewMessage busy>Opening…</PreviewMessage>;
  const sheet = sheets[active] ?? sheets[0];
  if (!sheet) return <PreviewMessage>This spreadsheet is empty.</PreviewMessage>;

  const fullWidth = sheet.rows.reduce((w, row) => Math.max(w, row.length), 0);
  const width = Math.min(MAX_COLUMNS, fullWidth);
  const rows = sheet.rows.slice(0, MAX_ROWS);
  const clipped = sheet.rows.length > MAX_ROWS || fullWidth > width;

  return (
    <div className="file-preview__sheet">
      <div
        className="file-preview__grid selectable"
        tabIndex={0}
        aria-label={`${sheet.name} of ${name}`}
      >
        <table>
          <thead>
            <tr>
              <th aria-hidden="true" />
              {Array.from({ length: width }, (_, c) => (
                <th key={c} scope="col">
                  {columnName(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                <th scope="row">{r + 1}</th>
                {Array.from({ length: width }, (_, c) => (
                  <td key={c} data-numeric={NUMERIC.test(row[c] ?? "") || undefined}>
                    {row[c] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {clipped && (
          <p className="file-preview__clipped">
            Showing the first {Math.min(sheet.rows.length, MAX_ROWS).toLocaleString()} rows and{" "}
            {width} columns. Open the file to see all of it.
          </p>
        )}
      </div>
      {sheets.length > 1 && (
        <div className="file-preview__tabs" role="tablist" aria-label="Sheets">
          {sheets.map((s, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === active}
              className="file-preview__tab"
              onClick={() => setActive(i)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
