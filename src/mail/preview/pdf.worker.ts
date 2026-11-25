// pdf.js's worker, with the built-ins it needs added first (see `pdfjsPolyfills.ts`). Imports run in
// order, so the polyfills are in place before pdf.js's worker code runs; it starts listening for the
// window on import.
import "./pdfjsPolyfills";
import "pdfjs-dist/build/pdf.worker.mjs";
