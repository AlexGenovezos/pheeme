/**
 * The newer JavaScript built-ins pdf.js calls, for the macOS versions whose WebKit lacks them.
 * pdf.js's standard build calls `Map.prototype.getOrInsertComputed`, `Promise.try`, `Uint8Array`'s
 * base64 and the like directly; Safari only has some of them from 26.2, so on an older Mac a PDF
 * page failed to draw ("TypeError | getOptionalContentConfig"). Each module adds its built-in only
 * where the engine lacks it (or has a known bug), so an up-to-date Mac keeps its own.
 *
 * Loaded before pdf.js in the window (`PdfView.tsx`) and in its worker (`pdf.worker.ts`). The list is
 * the one pdf.js's own legacy build bundles for the same release; `pdfjsPolyfills.test.ts` fails
 * when an upgrade of pdf.js needs one that isn't here.
 */
import "core-js/modules/es.array.includes.js";
import "core-js/modules/es.array.push.js";
import "core-js/modules/es.iterator.constructor.js";
import "core-js/modules/es.iterator.drop.js";
import "core-js/modules/es.iterator.every.js";
import "core-js/modules/es.iterator.filter.js";
import "core-js/modules/es.iterator.find.js";
import "core-js/modules/es.iterator.flat-map.js";
import "core-js/modules/es.iterator.for-each.js";
import "core-js/modules/es.iterator.map.js";
import "core-js/modules/es.iterator.some.js";
import "core-js/modules/es.iterator.take.js";
import "core-js/modules/es.iterator.to-array.js";
import "core-js/modules/es.json.parse.js";
import "core-js/modules/es.json.stringify.js";
import "core-js/modules/es.map.get-or-insert-computed.js";
import "core-js/modules/es.map.get-or-insert.js";
import "core-js/modules/es.math.sum-precise.js";
import "core-js/modules/es.promise.try.js";
import "core-js/modules/es.set.difference.v2.js";
import "core-js/modules/es.set.intersection.v2.js";
import "core-js/modules/es.set.is-disjoint-from.v2.js";
import "core-js/modules/es.set.is-subset-of.v2.js";
import "core-js/modules/es.set.is-superset-of.v2.js";
import "core-js/modules/es.set.symmetric-difference.v2.js";
import "core-js/modules/es.set.union.v2.js";
import "core-js/modules/es.typed-array.with.js";
import "core-js/modules/es.uint8-array.from-base64.js";
import "core-js/modules/es.uint8-array.set-from-base64.js";
import "core-js/modules/es.uint8-array.set-from-hex.js";
import "core-js/modules/es.uint8-array.to-base64.js";
import "core-js/modules/es.uint8-array.to-hex.js";
import "core-js/modules/es.weak-map.get-or-insert-computed.js";
import "core-js/modules/es.weak-map.get-or-insert.js";
import "core-js/modules/web.dom-exception.stack.js";
import "core-js/modules/web.self.js";
import "core-js/modules/web.url.parse.js";
