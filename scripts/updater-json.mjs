#!/usr/bin/env node
// Builds the updater's latest.json from a release's assets, once, after every platform has
// uploaded. tauri-action would otherwise have each build read-modify-write it, which races when
// the builds run in parallel. Keys and URLs match what tauri-action v1 writes: the NSIS exe (or
// the msi, when a release has one) and the AppImage are the primary Windows and Linux updaters,
// and macOS ships an Apple Silicon bundle. Older releases used universal or per-arch macOS
// bundles and Windows msi installers; those shapes stay supported. The NSIS installer removes an earlier
// msi install, so msi users update through it.
//
// usage: node scripts/updater-json.mjs <version> <assets.json> <sig-dir>
//   assets.json  `gh api repos/{owner}/{repo}/releases/{id}/assets` output
//   sig-dir      directory holding every *.sig asset, downloaded under its asset name
//   The release's tag comes from GITHUB_REF_NAME (the release job runs on the tag push).
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
    const arches = arch === "universal" ? ["aarch64", "x86_64", "universal"] : [arch];
    return arches.flatMap((a) => [`darwin-${a}`, `darwin-${a}-app`]);
  }
  m = name.match(/_(x64)(?:_[\w-]+)?\.msi$/);
  if (m) return [`windows-${ARCH[m[1]]}-msi`, `windows-${ARCH[m[1]]}`];
  m = name.match(/_(x64)-setup\.exe$/);
  if (m) return [`windows-${ARCH[m[1]]}-nsis`, `windows-${ARCH[m[1]]}`];
  m = name.match(/_(amd64)\.AppImage$/);
  if (m) return [`linux-${ARCH[m[1]]}-appimage`, `linux-${ARCH[m[1]]}`];
  m = name.match(/_(amd64)\.deb$/);
  if (m) return [`linux-${ARCH[m[1]]}-deb`];
  throw new Error(`no updater platform for signed asset ${name}`);
}

/**
 * The asset's public download link (github.com/…/releases/download/…), not its API URL, which
 * shares GitHub's 60 requests an hour for anyone signed out. While the release is a draft the link
 * says `untagged-…` and stops working once it's published, so the tag goes in its place, as
 * tauri-action does.
 */
function downloadUrl(asset, tag) {
  const url = asset.browser_download_url;
  if (!url) throw new Error(`no download link for asset ${asset.name}`);
  const untagged = /\/releases\/download\/untagged-[^/]+\//;
  if (!untagged.test(url)) return url;
  if (!tag) throw new Error(`asset ${asset.name} is on a draft; the release's tag is needed`);
  return url.replace(untagged, `/releases/download/${encodeURIComponent(tag)}/`);
}

/**
 * @param {{version: string, tag?: string,
 *          assets: {name: string, browser_download_url: string}[],
 *          signatures: Record<string, string>, pubDate: string}} input
 *   signatures maps an asset name (without .sig) to its signature file's contents.
 */
export function buildUpdaterJson({ version, tag, assets, signatures, pubDate }) {
  const platforms = {};
  // msi after nsis so `windows-x86_64` ends up on the msi when there is one, as tauri-action does.
  const signed = assets
    .filter((a) => signatures[a.name] !== undefined)
    .sort((a, b) => Number(a.name.endsWith(".msi")) - Number(b.name.endsWith(".msi")));
  for (const asset of signed) {
    for (const key of platformKeys(asset.name)) {
      platforms[key] = { signature: signatures[asset.name], url: downloadUrl(asset, tag) };
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
    signatures[file.slice(0, -".sig".length)] = fs.readFileSync(path.join(sigDir, file), "utf8");
  }
  const json = buildUpdaterJson({
    version,
    tag: process.env.GITHUB_REF_NAME,
    assets,
    signatures,
    pubDate: new Date().toISOString(),
  });
  process.stdout.write(JSON.stringify(json, null, 2) + "\n");
}
