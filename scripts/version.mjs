import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const VERSION_LINE = /^(\s*version\s*=\s*)"([^"]*)"/;

const files = {
  packageJson: "package.json",
  packageLock: "package-lock.json",
  cargoToml: "src-tauri/Cargo.toml",
  cargoLock: "src-tauri/Cargo.lock",
  tauriConf: "src-tauri/tauri.conf.json",
};

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");
const write = (root, file, text) => fs.writeFileSync(path.join(root, file), text);

// Index of the version line inside the block that starts at the first line matching `isStart`
// and ends at the next `[...]` header.
function findVersionLine(lines, isStart) {
  const start = lines.findIndex(isStart);
  if (start < 0) return -1;
  for (let i = start + 1; i < lines.length && !lines[i].startsWith("["); i++) {
    if (VERSION_LINE.test(lines[i])) return i;
  }
  return -1;
}

const cargoTomlLine = (lines) => findVersionLine(lines, (l) => l.trim() === "[package]");

function cargoLockLine(lines) {
  const name = lines.findIndex((l) => l.trim() === 'name = "pheeme"');
  return name >= 0 && VERSION_LINE.test(lines[name + 1] ?? "") ? name + 1 : -1;
}

function readLine(root, file, find) {
  const lines = read(root, file).split("\n");
  const i = find(lines);
  return i < 0 ? "(not found)" : lines[i].match(VERSION_LINE)[2];
}

export function readVersions(root) {
  const lock = JSON.parse(read(root, files.packageLock));
  const lockRoot = lock.packages?.[""]?.version;
  return {
    packageJson: JSON.parse(read(root, files.packageJson)).version,
    packageLock: lock.version === lockRoot ? lock.version : `${lock.version} / ${lockRoot}`,
    cargoToml: readLine(root, files.cargoToml, cargoTomlLine),
    cargoLock: readLine(root, files.cargoLock, cargoLockLine),
    tauriConf: JSON.parse(read(root, files.tauriConf)).version,
  };
}

export function checkVersions(root, expectedTag) {
  const versions = readVersions(root);
  const expected = expectedTag ? expectedTag.replace(/^v/, "") : versions.packageJson;
  const reference = expectedTag ? `tag ${expectedTag}` : "package.json";
  return Object.entries(files)
    .filter(([key]) => versions[key] !== expected)
    .map(
      ([key, file]) => `${file} has version ${versions[key]}, expected ${expected} (${reference})`,
    );
}

function setJson(root, file, update) {
  const data = JSON.parse(read(root, file));
  update(data);
  write(root, file, JSON.stringify(data, null, 2) + "\n");
}

function setLine(root, file, find, version) {
  const lines = read(root, file).split("\n");
  const i = find(lines);
  if (i < 0) throw new Error(`no version line found in ${file}`);
  lines[i] = lines[i].replace(VERSION_LINE, `$1"${version}"`);
  write(root, file, lines.join("\n"));
}

export function setVersion(root, version) {
  if (!SEMVER.test(version)) throw new Error(`not a semver version: ${version}`);
  setJson(root, files.packageJson, (d) => (d.version = version));
  setJson(root, files.packageLock, (d) => {
    d.version = version;
    d.packages[""].version = version;
  });
  setJson(root, files.tauriConf, (d) => (d.version = version));
  setLine(root, files.cargoToml, cargoTomlLine, version);
  setLine(root, files.cargoLock, cargoLockLine, version);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const [command, ...args] = process.argv.slice(2);
  if (command === "check") {
    const tagAt = args.indexOf("--tag");
    const errors = checkVersions(root, tagAt >= 0 ? args[tagAt + 1] : undefined);
    if (errors.length > 0) {
      console.error(errors.join("\n"));
      process.exit(1);
    }
    console.log("versions in sync");
  } else if (command === "set" && args[0]) {
    setVersion(root, args[0]);
    console.log(`set version ${args[0]}`);
  } else {
    console.error("usage: version.mjs check [--tag vX.Y.Z] | set X.Y.Z");
    process.exit(2);
  }
}
