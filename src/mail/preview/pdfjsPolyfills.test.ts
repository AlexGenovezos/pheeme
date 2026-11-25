import legacyWindow from "pdfjs-dist/legacy/build/pdf.mjs?raw";
import legacyWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs?raw";
import { afterEach, expect, it } from "vitest";
import ours from "./pdfjsPolyfills.ts?raw";

/** The core-js modules a file pulls in: imports here, `// MODULE:` markers in pdf.js's bundle. */
function modules(source: string, pattern: RegExp): string[] {
  return [...new Set([...source.matchAll(pattern)].map((m) => m[1]))].sort();
}

it("covers every built-in pdf.js's legacy build adds for this release", () => {
  const marker = /MODULE: \.\/node_modules\/core-js\/modules\/([\w.-]+\.js)/g;
  const needed = modules(legacyWindow + legacyWorker, marker);
  const imported = modules(ours, /^import "core-js\/modules\/([\w.-]+\.js)";$/gm);
  // A pdf.js upgrade that calls a new built-in fails here: add its module to pdfjsPolyfills.ts.
  expect(imported).toEqual(needed);
});

const MissingOnOldMacs = [
  [Map.prototype, "getOrInsertComputed"],
  [Map.prototype, "getOrInsert"],
  [WeakMap.prototype, "getOrInsertComputed"],
  [Math, "sumPrecise"],
  [Promise, "try"],
  [Uint8Array, "fromBase64"],
  [Uint8Array.prototype, "toBase64"],
] as const;

const saved = MissingOnOldMacs.map(
  ([owner, key]) => [owner, key, Reflect.get(owner, key)] as const,
);

afterEach(() => {
  for (const [owner, key, value] of saved) {
    if (value === undefined) Reflect.deleteProperty(owner, key);
    else Reflect.set(owner, key, value);
  }
});

/** The built-ins as the polyfills add them; TypeScript's `lib` here predates them. */
interface Added {
  map: Map<string, number> & { getOrInsertComputed(key: string, make: () => number): number };
  sumPrecise(values: number[]): number;
  try<T>(run: () => T): Promise<T>;
  fromBase64(text: string): Uint8Array;
  toBase64(bytes: Uint8Array): string;
}

it("adds the built-ins an older WebKit lacks", async () => {
  for (const [owner, key] of MissingOnOldMacs) Reflect.deleteProperty(owner, key);
  await import("./pdfjsPolyfills");

  const added: Added = {
    map: new Map() as Added["map"],
    sumPrecise: (values) => Reflect.apply(Reflect.get(Math, "sumPrecise"), Math, [values]),
    try: (run) => Reflect.apply(Reflect.get(Promise, "try"), Promise, [run]),
    fromBase64: (text) => Reflect.apply(Reflect.get(Uint8Array, "fromBase64"), Uint8Array, [text]),
    toBase64: (bytes) => Reflect.apply(Reflect.get(bytes, "toBase64"), bytes, []),
  };
  expect(added.map.getOrInsertComputed("a", () => 1)).toBe(1);
  expect(added.map.getOrInsertComputed("a", () => 2)).toBe(1);
  expect(added.sumPrecise([0.1, 0.2])).toBe(0.30000000000000004);
  await expect(added.try(() => 3)).resolves.toBe(3);
  expect(added.fromBase64("aGk=")).toEqual(new Uint8Array([104, 105]));
  expect(added.toBase64(new Uint8Array([104, 105]))).toBe("aGk=");
});
