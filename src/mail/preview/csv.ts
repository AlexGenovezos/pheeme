/**
 * Rows of a CSV (or TSV) file: quoted fields may hold the delimiter, doubled quotes and line breaks.
 * TSV is detected from the name, else from the first line.
 */
export function parseDelimited(text: string, filename: string | null): string[][] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstLine = body.slice(0, body.indexOf("\n") >>> 0);
  const tsv =
    /\.tsv$/i.test(filename ?? "") ||
    (firstLine.includes("\t") && !firstLine.includes(",") && !firstLine.includes(";"));
  const semicolon = !tsv && !firstLine.includes(",") && firstLine.includes(";");
  const delimiter = tsv ? "\t" : semicolon ? ";" : ",";

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && body[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
