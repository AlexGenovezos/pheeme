import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import App from "./App";

test("shows loading until the backend answers", () => {
  mockIPC(() => new Promise(() => {}));
  render(<App />);
  expect(screen.getByText("Loading...")).toBeInTheDocument();
  expect(screen.queryByText("Pheeme — ready")).not.toBeInTheDocument();
});

test("shows ready once greet resolves", async () => {
  mockIPC((cmd) => (cmd === "greet" ? "hi" : undefined));
  render(<App />);
  expect(await screen.findByText("Pheeme — ready")).toBeInTheDocument();
});

test("stays on loading and does not throw when greet rejects", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  mockIPC(() => {
    throw new Error("boom");
  });
  render(<App />);
  await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
  expect(screen.getByText("Loading...")).toBeInTheDocument();
});
