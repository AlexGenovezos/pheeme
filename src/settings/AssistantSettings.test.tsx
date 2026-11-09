import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ASSISTANT_ACTIVITY_EVENT } from "../lib/tauri";
import { createAssistantHandlers } from "../preview/assistant";
import { AssistantSettings, claudeCommand } from "./AssistantSettings";

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
let calls: string[];

beforeEach(() => {
  calls = [];
  const handlers = createAssistantHandlers() as Record<string, (args: unknown) => unknown>;
  mockIPC(
    (cmd, args) => {
      calls.push(cmd);
      return handlers[cmd]?.(args as never);
    },
    { shouldMockEvents: true },
  );
});
// Unmount (which stops listening for activity) while the event mock is still installed.
afterEach(() => {
  cleanup();
  clearMocks();
});

test("builds the Claude Code command", () => {
  expect(claudeCommand("http://127.0.0.1:43830/mcp", "pheeme_x")).toBe(
    'claude mcp add --transport http pheeme http://127.0.0.1:43830/mcp --header "Authorization: Bearer pheeme_x"',
  );
});

test("turns assistants on, connects one with a one-time command, and removes it", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.assign(navigator, { clipboard: { writeText } });
  render(<AssistantSettings />);
  // Every row is drawn before the status arrives.
  expect(screen.getByRole("switch", { name: "Allow MCP connections" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  await flush();

  const main = screen.getByRole("region", { name: "MCP server" });
  expect(main).toHaveTextContent("Off. Turn on Allow MCP connections");
  expect(screen.getByRole("region", { name: "Activity" })).toHaveTextContent("No activity yet");

  fireEvent.click(screen.getByRole("switch", { name: "Allow MCP connections" }));
  await flush();
  expect(calls).toContain("set_assistant_enabled");
  expect(main).toHaveTextContent("Listening at http://127.0.0.1:43830/mcp");

  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await flush();
  const command = screen.getByLabelText("Claude Code command");
  expect(command).toHaveTextContent("Authorization: Bearer pheeme_preview1");
  fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
  await flush();
  expect(writeText).toHaveBeenCalledWith(command.textContent);
  expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

  const connected = screen.getByRole("region", { name: "Connected clients" });
  expect(connected).toHaveTextContent("Claude Code");
  expect(connected).toHaveTextContent("not used yet");
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByLabelText("Claude Code command")).toBeNull();

  // Activity shows each call, and opens to exactly what was sent and what came back.
  await act(() => emit(ASSISTANT_ACTIVITY_EVENT));
  await flush();
  const log = screen.getByRole("region", { name: "Activity" });
  expect(log).toHaveTextContent("list_mailbox · inbox (unread)");
  expect(within(log).getByLabelText("Arguments")).toHaveTextContent('"unread_only": true');
  expect(within(log).getByLabelText("Returned")).toHaveTextContent('"t1"');

  fireEvent.click(within(connected).getByRole("button", { name: "Remove" }));
  await flush();
  expect(within(connected).queryByRole("button", { name: "Remove" })).toBeNull();
});
