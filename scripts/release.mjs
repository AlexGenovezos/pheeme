#!/usr/bin/env node
// Release helper. `prepare X.Y` bumps the version and drafts docs/releases/vX.Y.md from the PRs
// merged since the last tag; `check X.Y` is the gate before tagging (and in the release workflow);
// `notes X.Y` prints the notes as the release workflow publishes them (the GitHub release text). The steps around it live in the `release` skill
// (.claude/skills/release/SKILL.md).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isNewer, parseNotes, stripComments } from "./release-notes.mjs";
import { checkVersions, readVersions, setVersion } from "./version.mjs";

export { isNewer };

export const NOTES_DIR = "docs/releases";
const MIGRATIONS_DIR = "src-tauri/src/db/migrations";
const DRAFT_START = "<!-- DRAFT";
const DRAFT_END = "DRAFT -->";
/** PRs that don't change what someone using the app sees: listed apart in the draft. */
const BEHIND_THE_SCENES = /^(ci|build|chore|test|docs|refactor|perf\(ci\)|release)(\(.*?\))?!?:/i;

/** "0.8" or "v0.8" → { version: "0.8", tag: "v0.8" }. */
export function parseVersion(input) {
  const version = String(input ?? "").replace(/^v/, "");
  if (!/^\d+\.\d+$/.test(version)) throw new Error(`not a MAJOR.MINOR version: ${input}`);
  return { version, tag: `v${version}` };
}

export const notesPath = (root, tag) => path.join(root, NOTES_DIR, `${tag}.md`);
/** `file` relative to the repo, with `/` on every OS (for messages). */
const shown = (root, file) => path.relative(root, file).split(path.sep).join("/");

/**
 * PR numbers from first-parent commit subjects, oldest first: squash merges end in "(#65)",
 * merge commits start "Merge pull request #62".
 */
export function prNumbersFromSubjects(subjects) {
  const seen = new Set();
  const out = [];
  for (const s of [...subjects].reverse()) {
    const m = /^Merge pull request #(\d+)/.exec(s) ?? /\(#(\d+)\)\s*$/.exec(s);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      out.push(Number(m[1]));
    }
  }
  return out;
}

/** The draft notes for `tag`. `prs`: [{ number, title, url }]; `migrations`: added migration files. */
export function draftNotes({ tag, prevTag, prs, migrations }) {
  const features = prs.filter((p) => !BEHIND_THE_SCENES.test(p.title));
  const internal = prs.filter((p) => BEHIND_THE_SCENES.test(p.title));
  const item = (p) => `- #${p.number} ${p.title}\n  ${p.url}`;
  const lines = [
    `<!-- Release notes for ${tag}. The release workflow publishes this file as the GitHub release text.`,
    `     Write for people using the app: a one-line lead, then a bold heading per area with bullets`,
    `     on what they can do now. Keep the Heads-up if there is one. Remove every TODO and the DRAFT`,
    `     block; \`npm run release:check -- ${tag.slice(1)}\` fails while either is left. -->`,
    "",
    "TODO: one line on what this release is about.",
    "",
    "**TODO: an area (e.g. Compose)**",
    "- TODO",
    "",
  ];
  if (migrations.length > 0) {
    const names = migrations.map((m) => `\`${path.basename(m)}\``).join(", ");
    lines.push(
      "**Heads-up**",
      `- This version updates the local mail cache (${names}). Once it has run, older versions can't open the cache, so keep auto-update on.`,
      "",
    );
  }
  lines.push(`${DRAFT_START}: merged since ${prevTag ?? "the first commit"}. Delete this block.`);
  lines.push(...(features.length > 0 ? features.map(item) : ["(no app changes found)"]));
  if (internal.length > 0)
    lines.push("Behind the scenes (usually left out):", ...internal.map(item));
  lines.push(DRAFT_END, "");
  return lines.join("\n");
}

/** Why `text` can't be published yet; [] when it can. */
export function checkNotes(text) {
  if (text == null) return ["no release notes file"];
  const errors = [];
  if (text.includes(DRAFT_START)) errors.push("the DRAFT block is still there");
  const visible = stripComments(text);
  if (/\bTODO\b/.test(visible)) errors.push("a TODO is left");
  if (!visible.trim()) errors.push("the notes are empty");
  // The app shows the notes too (Settings › About), with only the format release-notes.mjs reads.
  if (!errors.length) errors.push(...parseNotes(text).errors);
  return errors;
}

/** The notes as published: without the writing guide and other HTML comments. */
export const publishedNotes = (text) => stripComments(text).trim().concat("\n");

/** Everything that must hold before `tag` is pushed. */
export function checkRelease(root, input) {
  const { tag } = parseVersion(input);
  const file = notesPath(root, tag);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  return [
    ...checkVersions(root, tag),
    ...checkNotes(text).map((e) => `${shown(root, file)}: ${e}`),
  ];
}

// ---- CLI (shells out to git and gh; the functions above are pure) ----

const sh = (root, cmd, args) =>
  execFileSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function lastTag(root) {
  try {
    return sh(root, "git", ["describe", "--tags", "--abbrev=0", "--match", "v*", "HEAD"]);
  } catch {
    return null;
  }
}

function repoUrl(root) {
  const remote = sh(root, "git", ["remote", "get-url", "origin"]);
  const m = /github\.com[:/](.+?)(?:\.git)?$/.exec(remote);
  return m ? `https://github.com/${m[1]}` : null;
}

function mergedPrs(root, prevTag) {
  const range = prevTag ? [`${prevTag}..HEAD`] : ["HEAD"];
  const subjects = sh(root, "git", ["log", "--first-parent", "--format=%s", ...range])
    .split("\n")
    .filter(Boolean);
  const base = repoUrl(root);
  return prNumbersFromSubjects(subjects).map((number) => {
    try {
      const pr = JSON.parse(sh(root, "gh", ["pr", "view", String(number), "--json", "title,url"]));
      return { number, title: pr.title, url: pr.url };
    } catch {
      // No gh or no network: fall back to the commit subject.
      const subject = subjects.find((s) => s.includes(`#${number}`)) ?? "";
      return {
        number,
        title: subject.replace(/\s*\(#\d+\)\s*$/, ""),
        url: `${base}/pull/${number}`,
      };
    }
  });
}

function addedMigrations(root, prevTag) {
  if (!prevTag) return [];
  return sh(root, "git", [
    "diff",
    "--name-only",
    "--diff-filter=A",
    `${prevTag}..HEAD`,
    "--",
    MIGRATIONS_DIR,
  ])
    .split("\n")
    .filter((f) => f.endsWith(".sql"));
}

function prepare(root, input, { force = false } = {}) {
  const { version, tag } = parseVersion(input);
  const current = readVersions(root).packageJson;
  if (!isNewer(`${version}.0`, current)) throw new Error(`${tag} isn't newer than ${current}`);
  if (sh(root, "git", ["status", "--porcelain"])) throw new Error("commit or stash changes first");
  const file = notesPath(root, tag);
  if (fs.existsSync(file) && !force) throw new Error(`${shown(root, file)} exists (--force)`);

  const prevTag = lastTag(root);
  const prs = mergedPrs(root, prevTag);
  const migrations = addedMigrations(root, prevTag);
  setVersion(root, version);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, draftNotes({ tag, prevTag, prs, migrations }));

  const rel = shown(root, file);
  console.log(
    `Version set to ${version}.0 in package.json, package-lock.json, Cargo.toml, Cargo.lock, tauri.conf.json.`,
  );
  console.log(`Drafted ${rel} from ${prs.length} PRs since ${prevTag ?? "the start"}.`);
  if (migrations.length)
    console.log(`New migrations since ${prevTag}: ${migrations.join(", ")} (Heads-up added).`);
  console.log(`\nNext: write the notes, then \`npm run release:check -- ${version}\`.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const [command, version, ...flags] = process.argv.slice(2);
  try {
    if (command === "prepare" && version) {
      prepare(root, version, { force: flags.includes("--force") });
    } else if (command === "check" && version) {
      const errors = checkRelease(root, version);
      if (errors.length) {
        console.error(errors.join("\n"));
        process.exit(1);
      }
      console.log(`${parseVersion(version).tag} is ready to tag`);
    } else if (command === "notes" && version) {
      process.stdout.write(
        publishedNotes(fs.readFileSync(notesPath(root, parseVersion(version).tag), "utf8")),
      );
    } else {
      console.error("usage: release.mjs prepare X.Y [--force] | check X.Y | notes X.Y");
      process.exit(2);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
