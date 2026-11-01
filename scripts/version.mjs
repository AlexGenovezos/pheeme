import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PUBLIC_VERSION = /^\d+\.\d+$/;
const PUBLIC_TAG = /^v\d+\.\d+$/;
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

const HEADER = /^\s*\[\[?[^\]]+\]\]?\s*(#.*)?$/;
const NAME_PHEEME = /^\s*name\s*=\s*"pheeme"\s*(#.*)?$/;

// Index of the version line in the first table whose header and body satisfy the predicates.
function findVersionLine(lines, isHeader, isBody = () => true) {
  for (let start = 0; start < lines.length; start++) {
    if (!HEADER.test(lines[start]) || !isHeader(lines[start])) continue;
    let end = start + 1;
    while (end < lines.length && !HEADER.test(lines[end])) end++;
    const body = lines.slice(start + 1, end);
    if (!isBody(body)) continue;
    const i = body.findIndex((l) => VERSION_LINE.test(l));
    return i < 0 ? -1 : start + 1 + i;
  }
  return -1;
}

const cargoTomlLine = (lines) => findVersionLine(lines, (h) => /^\s*\[package\]\s*(#.*)?$/.test(h));

const cargoLockLine = (lines) =>
  findVersionLine(
    lines,
    (h) => /^\s*\[\[package\]\]\s*(#.*)?$/.test(h),
    (body) => body.some((l) => NAME_PHEEME.test(l)),
  );

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

// Public versions are MAJOR.MINOR; files store MAJOR.MINOR.0 because Cargo and MSI need three parts.
export function checkVersions(root, expectedTag) {
  if (expectedTag && !PUBLIC_TAG.test(expectedTag)) {
    return [`tag ${expectedTag} is not of the form vMAJOR.MINOR`];
  }
  const versions = readVersions(root);
  const expected = expectedTag ? `${expectedTag.slice(1)}.0` : versions.packageJson;
  const reference = expectedTag ? `tag ${expectedTag}` : "package.json";
  return Object.entries(files).flatMap(([key, file]) => {
    const actual = versions[key];
    if (actual !== expected) {
      return [`${file} has version ${actual}, expected ${expected} (${reference})`];
    }
    return /^\d+\.\d+\.0$/.test(actual) ? [] : [`${file} has version ${actual}, patch must be 0`];
  });
}

// Replaces the string value at the given key path, leaving all other text untouched.
function replaceJsonString(text, targetPath, value) {
  const target = JSON.stringify(targetPath);
  const stack = [];
  let expectKey = false;
  let result = null;
  for (const m of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],]/g)) {
    const token = m[0];
    const top = stack[stack.length - 1];
    if (token === "{" || token === "[") {
      stack.push({ object: token === "{", key: "" });
      expectKey = token === "{";
    } else if (token === "}" || token === "]") {
      stack.pop();
      expectKey = false;
    } else if (token === ",") {
      expectKey = top?.object ?? false;
    } else if (expectKey) {
      top.key = JSON.parse(token);
      expectKey = false;
    } else if (JSON.stringify(stack.map((c) => c.key)) === target) {
      if (result) throw new Error(`duplicate ${targetPath.join(".")}`);
      result = text.slice(0, m.index) + JSON.stringify(value) + text.slice(m.index + token.length);
    }
  }
  if (!result) throw new Error(`${targetPath.join(".")} not found`);
  return result;
}

function setJson(root, file, paths, version) {
  let text = read(root, file);
  for (const p of paths) text = replaceJsonString(text, p, version);
  const data = JSON.parse(text);
  if (data.version !== version) throw new Error(`failed to set version in ${file}`);
  write(root, file, text);
}

function setLine(root, file, find, version) {
  const lines = read(root, file).split("\n");
  const i = find(lines);
  if (i < 0) throw new Error(`no version line found in ${file}`);
  lines[i] = lines[i].replace(VERSION_LINE, `$1"${version}"`);
  write(root, file, lines.join("\n"));
}

export function setVersion(root, version) {
  if (!PUBLIC_VERSION.test(version)) throw new Error(`not a MAJOR.MINOR version: ${version}`);
  version = `${version}.0`;
  setJson(root, files.packageJson, [["version"]], version);
  setJson(root, files.packageLock, [["version"], ["packages", "", "version"]], version);
  setJson(root, files.tauriConf, [["version"]], version);
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
    console.log(`set version ${args[0]}.0`);
  } else {
    console.error("usage: version.mjs check [--tag vX.Y] | set X.Y");
    process.exit(2);
  }
}
