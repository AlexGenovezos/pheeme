// Dev helper: screenshot a page at several scroll positions via Chrome DevTools Protocol.
// Usage: node scripts/shoot.mjs <url> <outPrefix> <width> <height> <scrollY,...> [waitMs]
import { spawn } from "node:child_process";
import { writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const [url, out, w, h, ys, wait = "1200"] = process.argv.slice(2);
const root = join(homedir(), ".cache/ms-playwright");
const dir = readdirSync(root).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const chrome = process.env.CHROME || join(root, dir, "chrome-headless-shell-linux64", "chrome-headless-shell");
if (!existsSync(chrome)) throw new Error("no chrome");
const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(chrome, ["--headless", "--no-sandbox", "--hide-scrollbars", `--remote-debugging-port=${port}`, `--window-size=${w},${h}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(100);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Emulation.setDeviceMetricsOverride", { width: +w, height: +h, deviceScaleFactor: 1, mobile: +w < 600 });
await send("Page.enable");
await send("Page.navigate", { url });
await sleep(+wait);
for (const y of ys.split(",")) {
  await send("Runtime.evaluate", { expression: `window.scrollTo(0, ${y.endsWith("%") ? `(document.documentElement.scrollHeight - innerHeight) * ${parseFloat(y) / 100}` : y})` });
  await sleep(+(process.env.SETTLE || 700));
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const f = `${out}-${y.replace("%", "pct")}.png`;
  writeFileSync(f, Buffer.from(data, "base64"));
  console.log(f);
}
ws.close(); proc.kill();
