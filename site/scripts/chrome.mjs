// Locate a headless Chromium for the site scripts: $CHROME if set, else the newest
// chrome-headless-shell in the Playwright cache.
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const root = join(homedir(), ".cache/ms-playwright");
  const dirs = existsSync(root)
    ? readdirSync(root).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()
    : [];
  for (const d of dirs) {
    const p = join(root, d, "chrome-headless-shell-linux64", "chrome-headless-shell");
    if (existsSync(p)) return p;
  }
  throw new Error("chrome-headless-shell not found; set CHROME=/path/to/chrome");
}
