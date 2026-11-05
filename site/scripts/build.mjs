import { cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sitePublic = fileURLToPath(new URL("../public/", import.meta.url));
const siteDist = fileURLToPath(new URL("../dist/", import.meta.url));
const demoDist = fileURLToPath(new URL("../dist/demo/", import.meta.url));

// Keep the marketing pages and app in one deploy. The demo uses the desktop
// entry point unchanged; outside Tauri it loads the existing fixture backend.
await rm(siteDist, { recursive: true, force: true });
await cp(sitePublic, siteDist, { recursive: true });
await build({
  root: repoRoot,
  base: "/demo/",
  build: { outDir: demoDist, emptyOutDir: true },
});
