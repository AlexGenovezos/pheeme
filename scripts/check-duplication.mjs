#!/usr/bin/env node
// Duplicate-code gate over jscpd (config: .jscpd.json, accepted clones: .duplication-baseline.json).
//
//   npm run dupes          fail on new copy-pasted code, warn on new look-alikes
//   npm run dupes:update   accept the current clones into the baseline
//
// A new exact clone (the same tokens in two places) fails: reuse or extract the shared code.
// A new "similar" clone (a function with the same shape as another, names and literals aside)
// is only a warning, since some patterns (one sqlx query per function) look alike on purpose.
// In GitHub Actions both are written as annotations on the PR's lines.
//
// The baseline keeps, per pair of files, the text each accepted copy matched (whitespace removed)
// and how many tokens the pair shares. A clone is known when both of its sides are part of an
// accepted text and its pair shares no more tokens than before: editing a copy only splits or
// shrinks it, and text beside it doesn't count. A new copy, one jscpd merges into a known clone by
// extending it, or one more copy of known code (jscpd matches it to the first) isn't. (jscpd's own
// fingerprints hash whole lines, so an edit beside a known copy would fail an unrelated PR.)
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(import.meta.dirname, "..");
const BASELINE = ".duplication-baseline.json";
const jscpd = fileURLToPath(import.meta.resolve("jscpd/run-jscpd.js"));

function scan(root) {
  const out = mkdtempSync(join(tmpdir(), "jscpd-"));
  try {
    const args = ["--absolute", "--reporters", "json", "--output", out, "--silent", "--no-tips"];
    execFileSync(process.execPath, [jscpd, ...args], { cwd: root, stdio: "inherit" });
    return JSON.parse(readFileSync(join(out, "jscpd-report.json"), "utf8")).duplicates;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const path = (root, f) => relative(root, f.name).replaceAll("\\", "/");
const kindOf = (clone) => (clone.kind === "exact" ? "exact" : "similar");
const pairOf = (root, clone) =>
  [path(root, clone.firstFile), path(root, clone.secondFile)].sort().join(" <> ");

/** The matched text of each side of a clone, whitespace removed. */
function sidesOf(clone, read) {
  return [clone.firstFile, clone.secondFile].map((f) =>
    read(f.name).subarray(f.startLoc.position, f.endLoc.position).toString().replace(/\s+/g, ""),
  );
}

function reader() {
  const files = new Map();
  return (name) => {
    if (!files.has(name)) files.set(name, readFileSync(name));
    return files.get(name);
  };
}

/** Every pair of files' copies by kind: the tokens they share and their texts. */
function accepted(root, clones) {
  const read = reader();
  const byKind = { exact: {}, similar: {} };
  for (const c of clones) {
    const pair = (byKind[kindOf(c)][pairOf(root, c)] ??= { tokens: 0, texts: new Set() });
    pair.tokens += c.tokens;
    for (const text of sidesOf(c, read)) pair.texts.add(text);
  }
  for (const kind of Object.keys(byKind))
    byKind[kind] = Object.fromEntries(
      Object.entries(byKind[kind])
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([pair, { tokens, texts }]) => [pair, { tokens, texts: [...texts].sort() }]),
    );
  return byKind;
}

/** Scans `root` with its .jscpd.json; returns the clones its baseline doesn't cover. */
export function findNewClones(root = repoRoot) {
  const clones = scan(root);
  const file = join(root, BASELINE);
  const baseline = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const now = accepted(root, clones);
  const read = reader();
  const isNew = (c) => {
    const pair = pairOf(root, c);
    const known = baseline[kindOf(c)]?.[pair] ?? { tokens: 0, texts: [] };
    if (now[kindOf(c)][pair].tokens > known.tokens) return true;
    return !sidesOf(c, read).every((side) => known.texts.some((text) => text.includes(side)));
  };
  const found = clones.filter(isNew);
  return {
    total: clones.length,
    exact: found.filter((c) => kindOf(c) === "exact"),
    similar: found.filter((c) => kindOf(c) === "similar"),
  };
}

export function updateBaseline(root = repoRoot) {
  writeFileSync(join(root, BASELINE), JSON.stringify(accepted(root, scan(root)), null, 2) + "\n");
}

const where = (root, f) => `${path(root, f)}:${f.startLoc.line}`;

function describe(clone, root = repoRoot) {
  return `${where(root, clone.firstFile)} ↔ ${where(root, clone.secondFile)} (${clone.kind}, ${clone.lines} lines)`;
}

/**
 * GitHub Actions workflow commands, one on each copy: the PR shows the one on its own lines.
 * An error for copied code, a warning for a look-alike.
 */
export function annotations(clone, root = repoRoot) {
  const exact = clone.kind === "exact";
  const sides = [
    [clone.firstFile, clone.secondFile],
    [clone.secondFile, clone.firstFile],
  ];
  return sides.map(([here, other]) => {
    const message = exact
      ? `These ${clone.lines} lines are also at ${where(root, other)}. Reuse or extract the shared code.`
      : `This has the same shape as ${where(root, other)}. Could that be reused?`;
    const title = exact ? "Duplicated code" : "Looks like existing code";
    const loc = `file=${path(root, here)},line=${here.startLoc.line},endLine=${here.endLoc.line}`;
    return `::${exact ? "error" : "warning"} ${loc},title=${title}::${message}`;
  });
}

function main() {
  if (process.argv.includes("--update")) {
    updateBaseline();
    return 0;
  }
  const { total, exact, similar } = findNewClones();
  if (process.env.GITHUB_ACTIONS)
    for (const c of [...exact, ...similar]) console.log(annotations(c).join("\n"));
  for (const c of similar) console.warn(`looks alike: ${describe(c)}`);
  for (const c of exact) console.error(`duplicated: ${describe(c)}`);
  if (exact.length > 0) {
    console.error(
      `\n${exact.length} new new block(s) of copied code. Reuse or extract the shared code; if the copy is ` +
        "deliberate, run `npm run dupes:update` and commit .duplication-baseline.json.",
    );
    return 1;
  }
  console.log(`No new copied code (${total} known clones, ${similar.length} new look-alike(s)).`);
  return 0;
}

if (process.argv[1] === import.meta.filename) process.exitCode = main();
