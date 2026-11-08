import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { TELEMETRY_TITLE, TelemetrySwitch } from "./telemetry";

function backend(stored: boolean, fail = false) {
  const calls: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "telemetry_enabled") return stored;
    if (cmd === "set_telemetry") {
      calls.push(args);
      if (fail) throw { code: "settings", message: "disk full" };
      stored = (args as { enabled: boolean }).enabled;
      return stored;
    }
  });
  return calls;
}

const toggle = () => screen.getByRole("switch", { name: TELEMETRY_TITLE });

test("shows the stored choice and turns the ping off", async () => {
  const calls = backend(true);
  render(<TelemetrySwitch />);
  await waitFor(() => expect(toggle()).toBeEnabled());
  expect(toggle()).toHaveAttribute("aria-checked", "true");
  fireEvent.click(toggle());
  await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "false"));
  expect(calls).toEqual([{ enabled: false }]);
});

test("shows a stored off and turns it back on", async () => {
  const calls = backend(false);
  render(<TelemetrySwitch />);
  await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "false"));
  fireEvent.click(toggle());
  await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "true"));
  expect(calls).toEqual([{ enabled: true }]);
});

test("flips back when saving the choice fails", async () => {
  backend(true, true);
  render(<TelemetrySwitch />);
  await waitFor(() => expect(toggle()).toBeEnabled());
  fireEvent.click(toggle());
  await waitFor(() => expect(toggle()).toBeEnabled());
  expect(toggle()).toHaveAttribute("aria-checked", "true");
});

test("stays disabled until the stored choice is known", () => {
  mockIPC(() => new Promise(() => {}));
  render(<TelemetrySwitch />);
  expect(toggle()).toBeDisabled();
  expect(toggle()).toHaveAttribute("aria-checked", "true");
});
