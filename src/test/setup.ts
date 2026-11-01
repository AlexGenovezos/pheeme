import "@testing-library/jest-dom/vitest";
import { clearMocks } from "@tauri-apps/api/mocks";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  if (typeof window === "undefined") return; // node-environment tests (scripts/)
  cleanup();
  clearMocks();
});
