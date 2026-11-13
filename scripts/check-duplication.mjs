#!/usr/bin/env node
// Duplicate-code gate over jscpd (config: .jscpd.json, accepted clones: .jscpd-baseline.json).
//
//   npm run dupes          fail on new copy-pasted code, warn on new look-alikes
//   npm run dupes:update   accept the current clones into the baseline
//
// A new exact clone (the same tokens in two places) fails: reuse or extract the shared code.
// A new "similar" clone (a function with the same shape as another, names and literals aside)
// is only a warning, since some patterns (one sqlx query per function) look alike on purpose.
// In GitHub Actions both are written as annotations on the PR's lines.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const repoRoot = join(import.meta.dirname, "..");
const jscpd = join(repoRoot, "node_modules", ".bin", "jscpd");

const run = (root, args) =>
  execFileSync(jscpd, [...args, "--silent", "--no-tips"], { cwd: root, stdio: "inherit" });

/** Scans `root` with its .jscpd.json; returns the clones its baseline doesn't have. */
export function findNewClones(root = repoRoot) {
  const out = mkdtempSync(join(tmpdir(), "jscpd-"));
  try {
    run(root, ["--absolute", "--reporters", "json", "--output", out]);
    const report = JSON.parse(readFileSync(join(out, "jscpd-report.json"), "utf8"));
    const found = report.duplicates.filter((d) => d.isNew);
    return {
      total: report.statistics.total.clones,
      exact: found.filter((c) => c.kind === "exact"),
      similar: found.filter((c) => c.kind !== "exact"),
    };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

export const updateBaseline = (root = repoRoot) => run(root, ["--update-baseline"]);

const where = (root, f) => `${relative(root, f.name)}:${f.startLoc.line}`;

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
    const loc = `file=${relative(root, here.name)},line=${here.startLoc.line},endLine=${here.endLoc.line}`;
    return `::${exact ? "error" : "warning"} ${loc},title=${title}::${message}`;
  });
}

function main() {
  const { total, exact, similar } = findNewClones();
  if (process.env.GITHUB_ACTIONS)
    for (const c of [...exact, ...similar]) console.log(annotations(c).join("\n"));
  for (const c of similar) console.warn(`looks alike: ${describe(c)}`);
  for (const c of exact) console.error(`duplicated: ${describe(c)}`);
  if (exact.length > 0) {
    console.error(
      `\n${exact.length} new block(s) of copied code. Reuse or extract the shared code; if the copy is ` +
        "deliberate, run `npm run dupes:update` and commit .jscpd-baseline.json.",
    );
    return 1;
  }
  console.log(`No new copied code (${total} known clones, ${similar.length} new look-alike(s)).`);
  return 0;
}

if (process.argv[1] === import.meta.filename) process.exitCode = main();
