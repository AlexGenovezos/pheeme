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
    const errors = checkVersions(fixture(), "v0.2");
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) expect(error).toContain("v0.2");
  });

  it("accepts versions that match the tag", () => {
    expect(checkVersions(fixture(), "v0.1")).toEqual([]);
  });

  it("rejects a three-part tag", () => {
    expect(checkVersions(fixture("0.2.0"), "v0.2.0").join("\n")).toContain("v0.2.0");
  });

  it("reports a non-zero patch in a file", () => {
    const errors = checkVersions(fixture("0.2.1"));
    expect(errors.join("\n")).toContain("patch");
  });

  it("passes for the real repo", () => {
    expect(checkVersions(repoRoot)).toEqual([]);
  });
});

describe("setVersion", () => {
  it("rewrites every file and leaves other entries alone", () => {
    const root = fixture();
    setVersion(root, "1.2");
    const v = readVersions(root);
    expect(v).toEqual({
      packageJson: "1.2.0",
      packageLock: "1.2.0",
      cargoToml: "1.2.0",
      cargoLock: "1.2.0",
      tauriConf: "1.2.0",
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

  it.each(["0.2.1", "1", "0.2-beta"])("rejects %s", (bad) => {
    expect(() => setVersion(fixture(), bad)).toThrow();
  });
});

describe("formatting and table boundaries", () => {
  const file = (root, name) => path.join(root, name);

  it("keeps inline arrays and indentation in JSON files", () => {
    const root = fixture();
    const tauri =
      '{\n    "productName": "Pheeme",\n    "version": "0.1.0",\n    "bundle": {"targets": ["app", "dmg"], "version": "7"}\n}';
    fs.writeFileSync(file(root, "src-tauri/tauri.conf.json"), tauri);
    setVersion(root, "1.2");
    expect(fs.readFileSync(file(root, "src-tauri/tauri.conf.json"), "utf8")).toBe(
      tauri.replace('"version": "0.1.0"', '"version": "1.2.0"'),
    );
  });

  it("only touches the root entries in package-lock.json", () => {
    const root = fixture();
    const lock = json({
      name: "pheeme",
      version: "0.1.0",
      packages: { "": { version: "0.1.0" }, "node_modules/x": { version: "0.1.0" } },
    });
    fs.writeFileSync(file(root, "package-lock.json"), lock);
    setVersion(root, "1.2");
    const out = JSON.parse(fs.readFileSync(file(root, "package-lock.json"), "utf8"));
    expect(out.packages["node_modules/x"].version).toBe("0.1.0");
    expect(out.packages[""].version).toBe("1.2.0");
  });

  it("finds the pheeme lock entry regardless of field order and comments", () => {
    const root = fixture();
    fs.writeFileSync(
      file(root, "src-tauri/Cargo.lock"),
      '[[package]]\nname = "foo"\nversion = "0.1.0"\n\n[[package]]\nversion = "0.1.0"\n# note\nname = "pheeme"\n',
    );
    expect(readVersions(root).cargoLock).toBe("0.1.0");
    setVersion(root, "1.2");
    expect(fs.readFileSync(file(root, "src-tauri/Cargo.lock"), "utf8")).toBe(
      '[[package]]\nname = "foo"\nversion = "0.1.0"\n\n[[package]]\nversion = "1.2.0"\n# note\nname = "pheeme"\n',
    );
  });

  it("handles a commented [package] header and indented tables", () => {
    const root = fixture();
    const toml =
      '[package] # app\nname = "pheeme"\nversion = "0.1.0"\n\n  [dependencies]\n  foo = "1"\n  version = "9.9.9"\n';
    fs.writeFileSync(file(root, "src-tauri/Cargo.toml"), toml);
    setVersion(root, "1.2");
    expect(fs.readFileSync(file(root, "src-tauri/Cargo.toml"), "utf8")).toBe(
      toml.replace('version = "0.1.0"', 'version = "1.2.0"'),
    );
  });

  it("reports a [package] without a version instead of reading another table", () => {
    const root = fixture();
    fs.writeFileSync(
      file(root, "src-tauri/Cargo.toml"),
      '[package]\nname = "pheeme"\n\n[workspace.package]\nversion = "0.1.0"\n',
    );
    expect(checkVersions(root).join("\n")).toContain("Cargo.toml");
    expect(() => setVersion(root, "1.2")).toThrow();
  });
});
