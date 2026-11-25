// pdf.js's worker, with the built-ins it needs added first (see `pdfjsPolyfills.ts`). Imports run in
// order, so the polyfills are in place before pdf.js's worker code runs; it starts listening for the
// window on import. vite.config's `pdfWorkerExport` gives the built file the export pdf.js's
// no-worker fallback reads.
import "./pdfjsPolyfills";
import "pdfjs-dist/build/pdf.worker.mjs";
