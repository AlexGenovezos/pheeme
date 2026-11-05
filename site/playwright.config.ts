import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  timeout: 45_000,
  workers: 1,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4174",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  webServer: {
    cwd: "..",
    command:
      "npm run build:site && python3 -m http.server 4174 --bind 127.0.0.1 --directory site/dist",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
