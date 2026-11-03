// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkNotes,
  checkRelease,
  draftNotes,
  isNewer,
  notesPath,
  parseVersion,
  prNumbersFromSubjects,
  publishedNotes,
} from "./release.mjs";
import { setVersion } from "./version.mjs";

const pr = (number, title) => ({
  number,
  title,
  url: `https://github.com/o/r/pull/${number}`,
});

describe("parseVersion and isNewer", () => {
  it("accepts X.Y with or without v", () => {
    expect(parseVersion("0.8")).toEqual({ version: "0.8", tag: "v0.8" });
    expect(parseVersion("v1.0")).toEqual({ version: "1.0", tag: "v1.0" });
    expect(() => parseVersion("0.8.1")).toThrow();
  });
  it("compares numerically", () => {
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("0.8.0", "0.8.0")).toBe(false);
    expect(isNewer("0.7.0", "0.8.0")).toBe(false);
  });
});

it("finds PRs in squash and merge subjects, oldest first, once each", () => {
  expect(
    prNumbersFromSubjects([
      "ci(release): faster builds (#65)",
      "Merge pull request #62 from o/fix/email",
      "feat(settings): one window (#63)",
      "release: v0.7 (#64)",
      "a direct commit",
      "Merge pull request #62 from o/fix/email",
    ]),
  ).toEqual([62, 64, 63, 65]);
});

describe("draftNotes", () => {
  const notes = draftNotes({
    tag: "v0.8",
    prevTag: "v0.7",
    prs: [pr(66, "feat(compose): write mail"), pr(65, "ci(release): faster builds")],
    migrations: [],
  });

  it("lists app changes, and internal ones apart, inside the DRAFT block", () => {
    const draft = notes.slice(notes.indexOf("<!-- DRAFT"));
    expect(draft).toContain("merged since v0.7");
    expect(draft.indexOf("#66 feat(compose)")).toBeLessThan(draft.indexOf("Behind the scenes"));
    expect(draft.indexOf("Behind the scenes")).toBeLessThan(draft.indexOf("#65 ci(release)"));
  });

  it("adds a Heads-up when a migration was added", () => {
    expect(notes).not.toContain("**Heads-up**");
    const withMigration = draftNotes({
      tag: "v0.8",
      prevTag: "v0.7",
      prs: [],
      migrations: ["src-tauri/src/db/migrations/004_search.sql"],
    });
    expect(withMigration).toContain("**Heads-up**");
    expect(withMigration).toContain("`004_search.sql`");
  });

  it("fails the check until written", () => {
    expect(checkNotes(notes)).toEqual(["the DRAFT block is still there", "a TODO is left"]);
  });
});

describe("checkNotes", () => {
  it("passes finished notes, and ignores TODO inside comments", () => {
    expect(checkNotes("<!-- TODO: guide -->\nCompose is here.\n\n**Compose**\n- Reply\n")).toEqual(
      [],
    );
  });
  it("rejects missing, empty and leftover notes", () => {
    expect(checkNotes(null)).toEqual(["no release notes file"]);
    expect(checkNotes("<!-- only a comment -->\n")).toEqual(["the notes are empty"]);
    expect(checkNotes("TODO: lead\n")).toEqual(["a TODO is left"]);
  });
});

describe("checkRelease", () => {
  const roots = [];
  afterEach(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  function repo(version) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pheeme-rel-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "src-tauri"));
    const write = (f, c) => fs.writeFileSync(path.join(root, f), c);
    const v = `${version}.0`;
    write("package.json", JSON.stringify({ name: "pheeme", version: v }));
    write(
      "package-lock.json",
      JSON.stringify({ name: "pheeme", version: v, packages: { "": { version: v } } }),
    );
    write("src-tauri/Cargo.toml", `[package]\nname = "pheeme"\nversion = "${v}"\n`);
    write("src-tauri/Cargo.lock", `[[package]]\nname = "pheeme"\nversion = "${v}"\n`);
    write("src-tauri/tauri.conf.json", JSON.stringify({ version: v }));
    return root;
  }

  it("needs matching versions and finished notes", () => {
    const root = repo("0.7");
    expect(checkRelease(root, "0.8").join("\n")).toMatch(/expected 0\.8\.0/);
    setVersion(root, "0.8");
    expect(checkRelease(root, "0.8")).toEqual(["docs/releases/v0.8.md: no release notes file"]);
    fs.mkdirSync(path.join(root, "docs/releases"), { recursive: true });
    fs.writeFileSync(notesPath(root, "v0.8"), "Compose is here.\n");
    expect(checkRelease(root, "v0.8")).toEqual([]);
  });
});

it("publishes the notes without the writing guide", () => {
  expect(publishedNotes("<!-- guide\n  more -->\n\nCompose is here.\n\n")).toBe(
    "Compose is here.\n",
  );
});
