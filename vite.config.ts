import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * Where no worker can start, pdf.js imports its worker file into the window and reads the file's
 * `WorkerMessageHandler` export. Vite drops a worker's exports, so the built
 * `src/mail/preview/pdf.worker.ts` gets it back from the global pdf.js's worker sets on load.
 */
const pdfWorkerExport: Plugin = {
  name: "pdf-worker-export",
  renderChunk(code, chunk) {
    if (!chunk.facadeModuleId?.endsWith("/src/mail/preview/pdf.worker.ts")) return null;
    // Under another local name: the bundle has its own top-level `WorkerMessageHandler`.
    return `${code}\nconst pdfjsHandler = globalThis.pdfjsWorker.WorkerMessageHandler;\nexport { pdfjsHandler as WorkerMessageHandler };\n`;
  },
};

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  worker: { format: "es" as const, plugins: () => [pdfWorkerExport] },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
