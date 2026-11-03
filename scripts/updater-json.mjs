#!/usr/bin/env node
// Builds the updater's latest.json from a release's assets, once, after every platform has
// uploaded. tauri-action would otherwise have each build read-modify-write it, which races when
// the builds run in parallel. Keys and URLs match what tauri-action v1 writes (msi and AppImage
// are the primary Windows and Linux updaters, a universal macOS bundle serves both arches).
//
// usage: node scripts/updater-json.mjs <version> <assets.json> <sig-dir>
//   assets.json  `gh api repos/{owner}/{repo}/releases/{id}/assets` output
//   sig-dir      directory holding every *.sig asset, downloaded under its asset name
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ARCH = {
  universal: "universal",
  aarch64: "aarch64",
  x64: "x86_64",
  amd64: "x86_64",
};

/** Platform keys an updater bundle serves, primary key last so it wins ties. */
function platformKeys(name) {
  let m = name.match(/_(universal|aarch64|x64)\.app\.tar\.gz$/);
  if (m) {
    const arch = ARCH[m[1]];
    const arches =
      arch === "universal" ? ["aarch64", "x86_64", "universal"] : [arch];
    return arches.flatMap((a) => [`darwin-${a}`, `darwin-${a}-app`]);
  }
  m = name.match(/_(x64)(?:_[\w-]+)?\.msi$/);
  if (m) return [`windows-${ARCH[m[1]]}-msi`, `windows-${ARCH[m[1]]}`];
  m = name.match(/_(x64)-setup\.exe$/);
  if (m) return [`windows-${ARCH[m[1]]}-nsis`];
  m = name.match(/_(amd64)\.AppImage$/);
  if (m) return [`linux-${ARCH[m[1]]}-appimage`, `linux-${ARCH[m[1]]}`];
  m = name.match(/_(amd64)\.deb$/);
  if (m) return [`linux-${ARCH[m[1]]}-deb`];
  throw new Error(`no updater platform for signed asset ${name}`);
}

/**
 * @param {{version: string, assets: {name: string, url: string}[],
 *          signatures: Record<string, string>, pubDate: string}} input
 *   signatures maps an asset name (without .sig) to its signature file's contents.
 */
export function buildUpdaterJson({ version, assets, signatures, pubDate }) {
  const platforms = {};
  // msi before nsis so `windows-x86_64` ends up on the msi, as tauri-action does.
  const signed = assets
    .filter((a) => signatures[a.name] !== undefined)
    .sort(
      (a, b) =>
        Number(a.name.endsWith(".msi")) - Number(b.name.endsWith(".msi")),
    );
  for (const asset of signed) {
    for (const key of platformKeys(asset.name)) {
      platforms[key] = { signature: signatures[asset.name], url: asset.url };
    }
  }
  return { version, notes: "", pub_date: pubDate, platforms };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, assetsFile, sigDir] = process.argv.slice(2);
  if (!version || !assetsFile || !sigDir) {
    console.error("usage: updater-json.mjs <version> <assets.json> <sig-dir>");
    process.exit(2);
  }
  const assets = JSON.parse(fs.readFileSync(assetsFile, "utf8"));
  const signatures = {};
  for (const file of fs.readdirSync(sigDir).filter((f) => f.endsWith(".sig"))) {
    signatures[file.slice(0, -".sig".length)] = fs.readFileSync(
      path.join(sigDir, file),
      "utf8",
    );
  }
  const json = buildUpdaterJson({
    version,
    assets,
    signatures,
    pubDate: new Date().toISOString(),
  });
  process.stdout.write(JSON.stringify(json, null, 2) + "\n");
}
