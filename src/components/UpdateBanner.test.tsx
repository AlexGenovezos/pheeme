import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { __resetForTests, useUpdateStore } from "../lib/updater";
import { UpdateBanner } from "./UpdateBanner";

beforeEach(() => __resetForTests());

test("renders nothing when there is no update", () => {
  const { container } = render(<UpdateBanner />);
  expect(container).toBeEmptyDOMElement();
});

test("shows the available version", () => {
  useUpdateStore.setState({ available: "0.2.0" });
  render(<UpdateBanner />);
  expect(screen.getByText("Pheeme 0.2 is ready")).toBeInTheDocument();
});

test("clicking restart applies the update", () => {
  const apply = vi.fn(async () => {});
  useUpdateStore.setState({ available: "0.2.0", apply });
  render(<UpdateBanner />);
  fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
  expect(apply).toHaveBeenCalledTimes(1);
});

test("button is disabled while applying", () => {
  useUpdateStore.setState({ available: "0.2.0", applying: true });
  render(<UpdateBanner />);
  expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
});

test.each([
  ["checking", "Checking for updates…"],
  ["current", "Pheeme is up to date"],
  ["failed", "Couldn't check for updates. Try again later."],
] as const)("shows the manual check result (%s)", (manualCheck, text) => {
  useUpdateStore.setState({ manualCheck });
  render(<UpdateBanner />);
  expect(screen.getByRole("status")).toHaveTextContent(text);
});

test("no OK button while checking", () => {
  useUpdateStore.setState({ manualCheck: "checking" });
  render(<UpdateBanner />);
  expect(screen.queryByRole("button")).toBeNull();
});

test("OK dismisses the manual check result", () => {
  useUpdateStore.setState({ manualCheck: "current" });
  render(<UpdateBanner />);
  fireEvent.click(screen.getByRole("button", { name: "OK" }));
  expect(screen.queryByRole("status")).toBeNull();
});

test("an available update takes precedence over the check result", () => {
  useUpdateStore.setState({ available: "0.2.0", manualCheck: "current" });
  render(<UpdateBanner />);
  expect(screen.getByRole("status")).toHaveTextContent("Pheeme 0.2 is ready");
});
