// Checks that score.js catches what it claims to: each case is a small page that must lose points
// (or pass) for a stated reason. Run: node scripts/ui-score/selftest.mjs
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scorer = fs.readFileSync(path.join(here, "score.js"), "utf8");
const FONT = "font: 13px/1.25 sans-serif;";

/** [name, html of #part, check(result) -> true when the scorer did its job] */
const CASES = [
  [
    "a clean part scores 100",
    `<button style="${FONT} height:28px; padding:0 8px">Save</button>`,
    (r) => r.total === 100,
  ],
  [
    "an icon button over unrelated text is an overlap",
    `<div style="position:relative; ${FONT}"><span>November 2026</span>
       <button aria-label="Next" style="position:absolute; left:20px; top:-6px; width:28px; height:28px"></button></div>`,
    (r) => r.defects.some((d) => d.startsWith("overlap")),
  ],
  [
    "a field too narrow for its value is clipped and cut",
    `<input value="November 2026" style="${FONT} width:20px; height:28px; box-sizing:border-box">`,
    (r) => r.n.clipped === 1 && r.defects.some((d) => d.startsWith("cut to")),
  ],
  [
    "a label in a too-narrow scrolling box is clipped, not skipped",
    `<div style="width:12px; overflow:auto; ${FONT} white-space:nowrap">November 2026</div>`,
    (r) => r.n.text === 1 && r.n.clipped === 1,
  ],
  [
    "white text on a white gradient fails contrast",
    `<div style="${FONT} color:#fff; background:linear-gradient(#fff, #fafafa)">Hard to read</div>`,
    (r) => r.n.contrastFail === 1,
  ],
  [
    "text on an image can't be verified, so it fails contrast",
    `<div style="${FONT} color:#fff; background:url(data:image/gif;base64,R0lGODlhAQABAAAAACw=)">On a photo</div>`,
    (r) => r.n.contrastFail === 1,
  ],
  [
    "a toast over a dialog's Save button is a defect",
    `<div role="dialog" style="${FONT}"><button class="ui-button" style="${FONT} height:28px">Save</button></div>
     <div style="position:fixed; left:0; top:0; width:200px; height:120px; ${FONT} background:#333; color:#fff">Turn on notifications?</div>`,
    (r) => r.defects.some((d) => d.startsWith("covered")),
  ],
  [
    "a short label that wraps is a defect",
    `<div style="width:60px; ${FONT}">November 2026</div>`,
    (r) => r.defects.some((d) => d.startsWith("wraps")),
  ],
  [
    "overlapping buttons (the mini month's circles) are an overlap",
    `<div style="display:flex; ${FONT}"><button style="width:26px; height:26px; margin-right:-6px">8</button><button style="width:26px; height:26px">9</button></div>`,
    (r) => r.defects.some((d) => d.startsWith("overlap")),
  ],
  [
    "a layout custom property doesn't exempt borders from measurement",
    `<div style="--cal-days: 7; ${FONT}">${[1, 2, 3, 4, 5]
      .map((i) => `<span style="border:1px solid rgb(${i * 40},0,0)">x${i}</span>`)
      .join("")}</div>`,
    (r) => r.s.borders < 10,
  ],
  [
    "one weak criterion is a defect even when the average is fine",
    `<div style="${FONT}">${Array.from({ length: 6 }, (_, i) => `<button style="width:14px; height:14px">${i}</button>`).join("")}</div>`,
    (r) => r.defects.some((d) => d.startsWith("weak criterion: hit")),
  ],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
let failed = 0;
for (const [name, html, ok] of CASES) {
  await page.setContent(
    `<!doctype html><body style="margin:20px; background:#fff; color:#111"><div id="part" style="padding:30px">${html}</div></body>`,
  );
  await page.evaluate(scorer);
  const r = await page.evaluate(() => globalThis.__score("#part"));
  const pass = ok(r);
  if (!pass) failed++;
  console.log(
    `${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `\n     ${JSON.stringify({ total: r.total, s: r.s, n: r.n, defects: r.defects })}`}`,
  );
}
await browser.close();
process.exit(failed ? 1 : 0);
