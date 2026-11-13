// Fails when a file the site would deploy is bigger than Cloudflare Workers
// accepts. `wrangler deploy` refuses the whole site over one such file
// ("Asset too large"), so the workflow runs this before every deploy and
// preview upload, and on pull requests, where nothing deploys, to catch it
// before it reaches main.
//
//   node site/scripts/check-assets.mjs [dir]   (default: site/dist)

import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Cloudflare Workers' limit for one static asset: 25 MiB. */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

export const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** Every file under `dir` over the limit, largest first. */
export async function oversizedAssets(dir, limit = MAX_ASSET_BYTES) {
  const found = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const { size } = await stat(path);
    if (size > limit) found.push({ path, size });
  }
  return found.sort((a, b) => b.size - a.size);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dir = process.argv[2] ?? fileURLToPath(new URL("../dist/", import.meta.url));
  const over = await oversizedAssets(dir);
  for (const { path, size } of over) {
    console.error(`::error file=${relative(process.cwd(), path)}::${mib(size)} is over Cloudflare's ${mib(MAX_ASSET_BYTES)} limit for one asset`);
  }
  if (over.length) process.exit(1);
  console.log(`Every asset in ${relative(process.cwd(), dir) || "."} is under ${mib(MAX_ASSET_BYTES)}.`);
}
