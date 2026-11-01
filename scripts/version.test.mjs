// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkVersions, readVersions, setVersion } from "./version.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = [];

const json = (value) => JSON.stringify(value, null, 2) + "\n";

function fixture(version = "0.1.0", tauriVersion = version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pheeme-ver-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src-tauri"));
  const write = (file, content) => fs.writeFileSync(path.join(root, file), content);
  write("package.json", json({ name: "pheeme", version }));
  write(
    "package-lock.json",
    json({ name: "pheeme", version, packages: { "": { name: "pheeme", version } } }),
  );
  write(
    "src-tauri/Cargo.toml",
    `[package]\nname = "pheeme"\nversion = "${version}"\n\n[dependencies]\nfoo = { version = "9.9.9" }\n`,
  );
  write(
    "src-tauri/Cargo.lock",
    `[[package]]\nname = "foo"\nversion = "0.1.0"\n\n[[package]]\nname = "pheeme"\nversion = "${version}"\ndependencies = [\n "foo",\n]\n`,
  );
  write("src-tauri/tauri.conf.json", json({ productName: "Pheeme", version: tauriVersion }));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("checkVersions", () => {
  it("returns no errors when all versions agree", () => {
    expect(checkVersions(fixture())).toEqual([]);
  });

  it("reports the file that disagrees", () => {
    const errors = checkVersions(fixture("0.1.0", "0.2.0"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("tauri.conf.json");
    expect(errors[0]).toContain("0.1.0");
    expect(errors[0]).toContain("0.2.0");
  });

  it("reports versions that differ from the tag", () => {
    const errors = checkVersions(fixture(), "v0.2.0");
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) expect(error).toContain("v0.2.0");
  });

  it("accepts versions that match the tag", () => {
    expect(checkVersions(fixture(), "v0.1.0")).toEqual([]);
  });

  it("passes for the real repo", () => {
    expect(checkVersions(repoRoot)).toEqual([]);
  });
});

describe("setVersion", () => {
  it("rewrites every file and leaves other entries alone", () => {
    const root = fixture();
    setVersion(root, "1.2.3");
    const v = readVersions(root);
    expect(v).toEqual({
      packageJson: "1.2.3",
      packageLock: "1.2.3",
      cargoToml: "1.2.3",
      cargoLock: "1.2.3",
      tauriConf: "1.2.3",
    });
    expect(fs.readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8")).toContain(
      'foo = { version = "9.9.9" }',
    );
    expect(fs.readFileSync(path.join(root, "src-tauri/Cargo.lock"), "utf8")).toContain(
      'name = "foo"\nversion = "0.1.0"',
    );
    for (const file of ["package.json", "package-lock.json", "src-tauri/tauri.conf.json"]) {
      expect(fs.readFileSync(path.join(root, file), "utf8").endsWith("}\n")).toBe(true);
    }
  });

  it("rejects a non-semver version", () => {
    expect(() => setVersion(fixture(), "1.2")).toThrow();
  });
});
