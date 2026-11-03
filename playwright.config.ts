import { defineConfig, devices } from "@playwright/test";

// Browser checks against the preview build (mocked IPC, fixtures). See docs/performance.md.
export default defineConfig({
  testDir: "e2e",
  timeout: 5 * 60_000,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "npx vite build && npx vite preview --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    // Always a fresh build: a server left running would test stale code.
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
