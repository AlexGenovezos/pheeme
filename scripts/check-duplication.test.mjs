// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { annotations, findNewClones, updateBaseline } from "./check-duplication.mjs";

const roots = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const block = (
  name,
) => `export function ${name}(items: { id: string; size: number }[], limit: number) {
  const kept: string[] = [];
  let total = 0;
  for (const item of items) {
    if (total + item.size > limit) break;
    total += item.size;
    kept.push(item.id);
  }
  return { kept, total, full: total >= limit };
}
`;

const other = `export function sizes(rows: { name: string; bytes: number }[], unit: number) {
  const out: string[] = [];
  for (const row of rows) {
    const scaled = Math.round(row.bytes / unit);
    if (scaled === 0) continue;
    out.push(\`\${row.name}: \${scaled}\`);
  }
  return out.join(", ");
}
`;

function project(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pheeme-dupes-")));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, ".jscpd.json"),
    JSON.stringify({ path: ["src"], minTokens: 30 }),
  );
  write(root, files);
  return root;
}

function write(root, files) {
  for (const [name, text] of Object.entries(files))
    fs.writeFileSync(path.join(root, "src", name), text);
}

describe("check-duplication", () => {
  it("accepts the clones in the baseline and fails on a new copy", () => {
    const root = project({ "a.ts": block("pack"), "b.ts": block("pack") });
    updateBaseline(root);
    expect(findNewClones(root).exact).toEqual([]);

    write(root, { "c.ts": `// another copy\n${block("pack")}` });
    const { exact } = findNewClones(root);
    expect(exact.length).toBeGreaterThan(0);
    const [first, second] = annotations(exact[0], root);
    expect(first).toMatch(
      /^::error file=src\/[abc]\.ts,line=\d+,endLine=\d+,title=Duplicated code::These \d+ lines are also at src\/[abc]\.ts:\d+\./,
    );
    expect(second).toMatch(/^::error file=src\/[abc]\.ts,/);
    expect(new Set([first, second].map((a) => a.match(/file=([^,]+)/)[1])).size).toBe(2);
  });

  it("doesn't fail when text beside a known copy changes", () => {
    const root = project({ "a.ts": block("pack"), "b.ts": `const x = 1;\n${block("pack")}` });
    updateBaseline(root);
    write(root, { "b.ts": `const renamed = 1; // edited\n\n${block("fill")}` });
    expect(findNewClones(root).exact).toEqual([]);
  });

  it("fails on a copy placed right after a known one", () => {
    const root = project({ "a.ts": block("pack") + other, "b.ts": block("pack") });
    updateBaseline(root);
    write(root, { "b.ts": block("pack") + other });
    expect(findNewClones(root).exact.length).toBeGreaterThan(0);
  });

  it("fails on a new copy even when a known one shrank in the same files", () => {
    const root = project({ "a.ts": block("pack") + other, "b.ts": block("pack") });
    updateBaseline(root);
    write(root, {
      "b.ts": `${block("pack").replaceAll("total", "sum")}\nconst gap = 0;\n\n${other}`,
    });
    expect(findNewClones(root).exact.length).toBeGreaterThan(0);
  });

  it("finds nothing new in code without copies", () => {
    const root = project({ "a.ts": block("pack") });
    updateBaseline(root);
    expect(findNewClones(root)).toMatchObject({ exact: [], similar: [] });
  });
});
