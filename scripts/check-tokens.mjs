#!/usr/bin/env node
// Design-token guard (design doc §6): component CSS may not hard-code colors,
// lengths or durations. Raw values belong in src/styles/tokens.css and the
// theme files (src/styles/themes/*.ts). Run: node scripts/check-tokens.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ALLOWED = new Set([
  "src/styles/tokens.css",
  // Phase 2 onboarding predates the design system; remove once it is restyled (issue #13).
  "src/onboarding/onboarding.css",
]);

const RULES = [
  { name: "hex color", re: /#[0-9a-f]{3,8}\b/gi },
  { name: "color function", re: /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/gi },
  // Any non-zero length or duration, signed or not (but not digits inside names like
  // `--space-4`). Unitless numbers, %, fr and zero are fine.
  {
    name: "length/duration",
    re: /(?<![\w#]|\w-)(?!0*\.?0+(?:px|r?em|m?s|v[hw]|pt|ch)\b)\d*\.?\d+(?:px|r?em|ms|s|v[hw]|pt|ch)\b/g,
  },
];

/** Raw values in a stylesheet, ignoring comments. */
export function findRawValues(css) {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return RULES.flatMap(({ name, re }) => [...code.matchAll(re)].map((m) => `${name} ${m[0]}`));
}

function cssFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(full);
    return entry.name.endsWith(".css") ? [full] : [];
  });
}

/** `{ file, values }` for every stylesheet under src/ that breaks the rule. */
export function checkTokens(root = repoRoot) {
  return cssFiles(path.join(root, "src"))
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .filter((file) => !ALLOWED.has(file))
    .map((file) => ({
      file,
      values: findRawValues(fs.readFileSync(path.join(root, file), "utf8")),
    }))
    .filter((r) => r.values.length > 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkTokens();
  for (const { file, values } of problems) console.error(`${file}: ${values.join(", ")}`);
  if (problems.length) {
    console.error("\nUse a token from src/styles/tokens.css or the theme instead of a raw value.");
    process.exit(1);
  }
}
