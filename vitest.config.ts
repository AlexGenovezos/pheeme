import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs", "workers/**/*.test.ts"],
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/test/**", "src/**/*.test.*", "src/main.tsx", "src/vite-env.d.ts"],
      reporter: ["text-summary", "lcov"],
      // About 1.5 points under the measured 85.5% (2026-11-16), so a drop in coverage fails CI.
      thresholds: { lines: 84 },
    },
  },
});
