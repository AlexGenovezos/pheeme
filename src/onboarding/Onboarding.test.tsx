import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { AccountInfo } from "../lib/tauri";
import { Onboarding } from "./Onboarding";
import { loadProgress, saveProgress } from "./progress";

const CLIENT_ID = "123-abc.apps.googleusercontent.com";
const account: AccountInfo = {
  id: "a1",
  email: "me@example.com",
  displayName: null,
  clientId: CLIENT_ID,
};

type Handler = (args: Record<string, unknown>) => unknown;

function backend(handlers: Record<string, Handler>) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> });
    return handlers[cmd]?.(args as Record<string, unknown>);
  });
  return calls;
}

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));

beforeEach(() => {
  localStorage.clear();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

function fillCredentials(id = CLIENT_ID, secret = "s3cret") {
  fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: id } });
  fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: secret } });
}

test("walks the guide in order and saves progress without the secret", () => {
  backend({});
  render(<Onboarding accounts={[]} onConnected={() => {}} />);
  click("Get started");
  expect(screen.getByText("Create a Google Cloud project")).toBeInTheDocument();
  expect(loadProgress().step).toBe("project");
  for (const title of [
    "Turn on the Gmail API",
    "Turn on the Google Calendar API",
    "Set up the sign-in screen",
    "Add Pheeme's links to the branding",
    "Publish the app",
    "Create a desktop client",
    "Paste your client ID and secret",
  ]) {
    click("Next");
    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
  }
  fillCredentials();
  expect(JSON.stringify(localStorage)).not.toContain("s3cret");
  expect(loadProgress().clientId).toBe(CLIENT_ID);
});

test("resumes at the saved step, and after the form resumes at the form", () => {
  backend({});
  saveProgress({ step: "publish", clientId: "" });
  const { unmount } = render(<Onboarding accounts={[]} onConnected={() => {}} />);
  expect(screen.getByRole("heading", { name: "Publish the app" })).toBeInTheDocument();
  unmount();
  saveProgress({ step: "authorize", clientId: CLIENT_ID });
  render(<Onboarding accounts={[]} onConnected={() => {}} />);
  expect(screen.getByLabelText("Client ID")).toHaveValue(CLIENT_ID);
});

test("copy buttons copy the exact values and deep links open the console", async () => {
  const calls = backend({});
  saveProgress({ step: "client", clientId: "" });
  render(<Onboarding accounts={[]} onConnected={() => {}} />);
  fireEvent.click(screen.getAllByRole("button", { name: "Copy" })[0]);
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Desktop app");
  click(/Open Create client/);
  await vi.waitFor(() =>
    expect(calls).toContainEqual({
      cmd: "open_external",
      args: { url: "https://console.cloud.google.com/auth/clients/create" },
    }),
  );
});

test("credentials form validates the client ID and accepts the pasted JSON file", () => {
  backend({});
  saveProgress({ step: "credentials", clientId: "" });
  render(<Onboarding accounts={[]} onConnected={() => {}} />);
  const next = screen.getByRole("button", { name: "Next" });
  fillCredentials("not-an-id", "x");
  expect(screen.getByText(/A client ID ends in/)).toBeInTheDocument();
  expect(next).toBeDisabled();

  fireEvent.change(screen.getByLabelText("Client ID"), {
    target: { value: JSON.stringify({ web: { client_id: "w", client_secret: "s" } }) },
  });
  expect(screen.getByText(/Web application client/)).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Client ID"), {
    target: {
      value: JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: "from-json" } }),
    },
  });
  expect(screen.getByLabelText("Client ID")).toHaveValue(CLIENT_ID);
  expect(screen.getByLabelText("Client secret")).toHaveValue("from-json");
  expect(next).toBeEnabled();
});

test("signs in: explains the warning, opens Google, and confirms the account", async () => {
  const onConnected = vi.fn();
  const calls = backend({
    begin_oauth: () => ({
      flowId: "f1",
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
    }),
    complete_oauth: () => account,
  });
  saveProgress({ step: "credentials", clientId: "" });
  render(<Onboarding accounts={[]} onConnected={onConnected} />);
  fillCredentials(` ${CLIENT_ID} `);
  click("Next");
  expect(screen.getByText(/Google hasn't verified this app/)).toBeInTheDocument();
  click("Continue to Google");

  expect(await screen.findByText("me@example.com is connected")).toBeInTheDocument();
  expect(calls.find((c) => c.cmd === "begin_oauth")?.args).toEqual({
    client: { kind: "new", clientId: CLIENT_ID, clientSecret: "s3cret" },
  });
  expect(calls.map((c) => c.cmd)).toContain("open_external");
  expect(localStorage.getItem("pheeme.onboarding.v1")).toBeNull();
  click("Continue");
  expect(onConnected).toHaveBeenCalledWith(account);
});

test("waiting screen lists browser-side errors and cancel stops the sign-in", async () => {
  const calls = backend({
    begin_oauth: () => ({ flowId: "f1", authUrl: "https://accounts.google.com/x" }),
    complete_oauth: () => new Promise(() => {}),
  });
  saveProgress({ step: "credentials", clientId: "" });
  render(<Onboarding accounts={[]} onConnected={() => {}} />);
  fillCredentials();
  click("Next");
  click("Continue to Google");
  expect(await screen.findByText("Finish signing in in your browser")).toBeInTheDocument();
  for (const code of [
    "redirect_uri_mismatch",
    "invalid_client",
    "org_internal",
    "access_denied",
    "admin_policy_enforced",
  ]) {
    expect(screen.getByText(new RegExp(code))).toBeInTheDocument();
  }
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "Copy sign-in link" })).toBeEnabled(),
  );
  click("Cancel");
  expect(calls).toContainEqual({ cmd: "cancel_oauth", args: { flowId: "f1" } });
  expect(screen.getByLabelText("Client secret")).toHaveValue("s3cret");
});

test("a sign-in error shows the plain-language fix and can retry", async () => {
  let attempts = 0;
  backend({
    begin_oauth: () => ({ flowId: `f${++attempts}`, authUrl: "https://accounts.google.com/x" }),
    complete_oauth: () => {
      if (attempts === 1) {
        throw {
          code: "invalid_grant",
          message: "Publish the app to In production, then sign in again.",
        };
      }
      return account;
    },
  });
  saveProgress({ step: "credentials", clientId: "" });
  render(<Onboarding accounts={[]} onConnected={() => {}} />);
  fillCredentials();
  click("Next");
  click("Continue to Google");
  expect(await screen.findByRole("heading", { name: "Signed out by Google" })).toBeInTheDocument();
  expect(screen.getByText(/In production/)).toBeInTheDocument();
  click("Try again");
  expect(await screen.findByText("me@example.com is connected")).toBeInTheDocument();
});

test("a credentials error leads back to the form", async () => {
  backend({
    begin_oauth: () => {
      throw { code: "invalid_input", message: "That doesn't look like a client ID." };
    },
  });
  saveProgress({ step: "credentials", clientId: "" });
  render(<Onboarding accounts={[]} onConnected={() => {}} />);
  fillCredentials();
  click("Next");
  click("Continue to Google");
  await screen.findByRole("alert");
  click("Change client ID or secret");
  expect(screen.getByLabelText("Client ID")).toHaveValue(CLIENT_ID);
});

test("adding an account offers to reuse each existing client", async () => {
  const second: AccountInfo = { ...account, id: "a2", email: "two@example.com" };
  const work: AccountInfo = {
    ...account,
    id: "a3",
    email: "me@work.com",
    clientId: "w.apps.googleusercontent.com",
  };
  const calls = backend({
    begin_oauth: () => ({ flowId: "f1", authUrl: "https://accounts.google.com/x" }),
    complete_oauth: () => ({ ...account, id: "a4", email: "new@example.com" }),
  });
  const onClose = vi.fn();
  render(
    <Onboarding accounts={[account, second, work]} onConnected={() => {}} onClose={onClose} />,
  );
  expect(screen.getAllByText("Use the same Google Cloud app")).toHaveLength(2);
  expect(screen.queryByRole("navigation")).toBeNull();
  fireEvent.click(screen.getByText(/The one me@work.com signed in with/));
  expect(await screen.findByText("new@example.com is connected")).toBeInTheDocument();
  expect(calls.find((c) => c.cmd === "begin_oauth")?.args).toEqual({
    client: { kind: "sameAs", accountId: "a3" },
  });
  expect(localStorage.getItem("pheeme.onboarding.v1")).toBeNull();
});

test("adding with a different client can open the full guide", () => {
  backend({});
  render(<Onboarding accounts={[account]} onConnected={() => {}} onClose={() => {}} />);
  fireEvent.click(screen.getByText("Use a different OAuth client"));
  click("Follow the setup guide");
  expect(
    screen.getByRole("heading", { name: "Create a Google Cloud project" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("navigation", { name: "Setup steps" })).toBeInTheDocument();
});

test("leaving mid-sign-in cancels the backend wait", async () => {
  const calls = backend({
    begin_oauth: () => ({ flowId: "f9", authUrl: "https://accounts.google.com/x" }),
    complete_oauth: () => new Promise(() => {}),
  });
  const { unmount } = render(
    <Onboarding accounts={[account]} onConnected={() => {}} onClose={() => {}} />,
  );
  fireEvent.click(screen.getByText(/The one me@example.com signed in with/));
  await screen.findByText("Finish signing in in your browser");
  await act(async () => {});
  unmount();
  expect(calls).toContainEqual({ cmd: "cancel_oauth", args: { flowId: "f9" } });
});

test("cancelling while begin_oauth is still pending never opens Google", async () => {
  let resolveBegin: (value: unknown) => void = () => {};
  const calls = backend({
    begin_oauth: () => new Promise((resolve) => (resolveBegin = resolve)),
    complete_oauth: () => account,
  });
  render(<Onboarding accounts={[account]} onConnected={() => {}} onClose={() => {}} />);
  fireEvent.click(screen.getByText(/The one me@example.com signed in with/));
  await vi.waitFor(() => expect(calls.map((c) => c.cmd)).toContain("begin_oauth"));
  // The waiting screen's Cancel (the second one closes the add-account screen).
  fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0]);
  await act(async () => resolveBegin({ flowId: "late", authUrl: "https://accounts.google.com/x" }));
  await vi.waitFor(() =>
    expect(calls).toContainEqual({ cmd: "cancel_oauth", args: { flowId: "late" } }),
  );
  const cmds = calls.map((c) => c.cmd);
  expect(cmds).not.toContain("open_external");
  expect(cmds).not.toContain("complete_oauth");
  expect(screen.getByText("Add an account")).toBeInTheDocument();
});
