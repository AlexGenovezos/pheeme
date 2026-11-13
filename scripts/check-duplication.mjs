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
// The baseline holds how many tokens each pair of files shares, rather than jscpd's fingerprints,
// which hash whole lines: editing text beside a known copy would change them and fail an unrelated
// PR. Copying more code into a pair raises its total even when jscpd merges it into a known clone;
// editing a copy only splits or shrinks it.
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

/** How many duplicated tokens of each kind every pair of files shares. */
function count(root, clones) {
  const counts = { exact: {}, similar: {} };
  for (const c of clones) {
    const byPair = counts[kindOf(c)];
    const pair = pairOf(root, c);
    byPair[pair] = (byPair[pair] ?? 0) + c.tokens;
  }
  for (const kind of Object.keys(counts))
    counts[kind] = Object.fromEntries(Object.entries(counts[kind]).sort());
  return counts;
}

/** Scans `root` with its .jscpd.json; returns the clones of pairs that share more than the baseline. */
export function findNewClones(root = repoRoot) {
  const clones = scan(root);
  const file = join(root, BASELINE);
  const baseline = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const counts = count(root, clones);
  const isNew = (c) => {
    const pair = pairOf(root, c);
    return counts[kindOf(c)][pair] > (baseline[kindOf(c)]?.[pair] ?? 0);
  };
  const found = clones.filter(isNew);
  return {
    total: clones.length,
    exact: found.filter((c) => kindOf(c) === "exact"),
    similar: found.filter((c) => kindOf(c) === "similar"),
  };
}

export function updateBaseline(root = repoRoot) {
  writeFileSync(join(root, BASELINE), JSON.stringify(count(root, scan(root)), null, 2) + "\n");
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
      `\n${exact.length} new copied block(s) in file pairs that now share more code than before. Reuse or extract the shared code; if the copy is ` +
        "deliberate, run `npm run dupes:update` and commit .duplication-baseline.json.",
    );
    return 1;
  }
  console.log(`No new copied code (${total} known clones, ${similar.length} new look-alike(s)).`);
  return 0;
}

if (process.argv[1] === import.meta.filename) process.exitCode = main();
