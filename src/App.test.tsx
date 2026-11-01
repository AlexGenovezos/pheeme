import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import App from "./App";
import { useAccountStore } from "./store/accountStore";

const account = { id: "a1", email: "me@example.com", displayName: "Me", clientId: "c.apps.googleusercontent.com" };

beforeEach(() => {
  localStorage.clear();
  useAccountStore.setState({ accounts: [], loaded: false, error: null });
});

test("renders nothing until accounts load", () => {
  mockIPC(() => new Promise(() => {}));
  const { container } = render(<App />);
  expect(container.querySelector(".onboarding")).toBeNull();
});

test("first run with no accounts opens the setup guide", async () => {
  mockIPC((cmd) => (cmd === "list_accounts" ? [] : undefined));
  render(<App />);
  expect(await screen.findByText("Connect Gmail with your own Google Cloud app")).toBeInTheDocument();
  expect(screen.getByRole("navigation", { name: "Setup steps" })).toBeInTheDocument();
});

test("with accounts it shows them and can add or remove one", async () => {
  const calls: string[] = [];
  mockIPC((cmd) => {
    calls.push(cmd);
    return cmd === "list_accounts" ? [account] : undefined;
  });
  render(<App />);
  expect(await screen.findByText("Me")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Add account" }));
  expect(screen.getByText("Add an account")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(screen.getByText(/Nothing changes in Gmail/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await vi.waitFor(() => expect(screen.queryByText("Me")).not.toBeInTheDocument());
  expect(calls).toContain("remove_account");
});

test("a failed remove keeps the account and shows why", async () => {
  mockIPC((cmd) => {
    if (cmd === "list_accounts") return [account];
    if (cmd === "remove_account") throw { code: "keychain_unavailable", message: "No system keychain is available." };
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("No system keychain is available.");
  expect(screen.getByText("Me")).toBeInTheDocument();
});

test("a backend failure on load is shown, not swallowed", async () => {
  mockIPC(() => {
    throw { code: "internal", message: "Something went wrong: disk full" };
  });
  render(<App />);
  expect(await screen.findByText("Pheeme couldn't start")).toBeInTheDocument();
  expect(screen.getByText("Something went wrong: disk full")).toBeInTheDocument();
});
