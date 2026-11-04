import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { createModHandlers } from "../preview/mods";
import { registry } from "../keyboard/registry";
import { useCommands } from "../keyboard/useCommands";
import { useModCommands } from "./lifecycle";
import { ModsSettings } from "./ModsSettings";
import { ModPanel, ModSidebar } from "./ModSurfaces";
import { useModStore } from "./store";

beforeEach(() => {
  registry.clear();
  useModStore.setState({ mods: [], safeMode: false, loaded: false, error: null, panel: null });
});

function installFixtures(seeded = false, safeMode = false) {
  const handlers = createModHandlers(new URLSearchParams(seeded ? "mods=1" : ""));
  const invoke = vi.fn((command: string, args?: unknown) => {
    const handler = handlers[command as keyof typeof handlers];
    if (command === "list_mods") return { ...handlers.list_mods(), safeMode };
    if (handler) return handler(args as Record<string, unknown>);
    throw new Error(`Unexpected command: ${command}`);
  });
  mockIPC(invoke);
  return invoke;
}

test("installation requires explicit permission review and disabling removes controls", async () => {
  const invoke = installFixtures();
  await useModStore.getState().load();
  render(
    <>
      <ModsSettings />
      <ModSidebar />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Install from folder" }));
  expect(await screen.findByRole("button", { name: "Install and enable" })).toBeVisible();
  expect(useModStore.getState().mods).toHaveLength(0);
  expect(screen.getByText("This mod needs no network or account access.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Install and enable" }));
  expect(await screen.findByRole("switch", { name: "Enable Counter" })).toBeChecked();
  const sidebar = within(screen.getByRole("region", { name: "Mods" }));
  fireEvent.click(sidebar.getByRole("button", { name: "+1" }));
  expect(await sidebar.findByText("My counter: 1")).toBeVisible();
  fireEvent.click(screen.getByRole("switch", { name: "Enable Counter" }));
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Mods" })).not.toBeInTheDocument(),
  );
  expect(invoke).toHaveBeenCalledWith("set_mod_enabled", { id: "example.counter", enabled: false });
});

test("commands are owned by a mod, preserve built-in shortcuts, and unregister on disable", async () => {
  installFixtures(true);
  await useModStore.getState().load();
  const builtIn = vi.fn();
  registry.register({ id: "conversation.archive", title: "Archive", shortcut: "e", run: builtIn });
  act(() =>
    useModStore.setState((s) => ({
      mods: s.mods.map((m) => ({
        ...m,
        manifest: {
          ...m.manifest,
          commands: [{ id: "increment", title: "Increment counter", shortcut: "e" }],
        },
      })),
    })),
  );
  function Commands() {
    useModCommands();
    return null;
  }
  render(<Commands />);
  expect(registry.get("mod:example.counter:increment")?.shortcut).toBeUndefined();
  act(() => registry.get("mod:example.counter:increment")?.run());
  await waitFor(() =>
    expect(useModStore.getState().mods[0].views.panel[0]).toEqual({
      type: "text",
      text: "My counter: 1",
    }),
  );
  act(() => useModStore.setState((s) => ({ mods: s.mods.map((m) => ({ ...m, running: false })) })));
  expect(registry.get("mod:example.counter:increment")).toBeUndefined();
  expect(registry.get("conversation.archive")?.run).toBe(builtIn);
});

test("a mod panel opens, renders contributed controls, and closes with Escape", async () => {
  installFixtures(true);
  await useModStore.getState().load();
  render(
    <>
      <ModSidebar />
      <ModPanel />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Counter" }));
  const panel = await screen.findByRole("region", { name: "Counter panel" });
  expect(panel).toHaveFocus();
  fireEvent.click(within(panel).getByRole("button", { name: "Add one" }));
  expect(await within(panel).findByText("My counter: 1")).toBeVisible();
  fireEvent.keyDown(panel, { key: "Escape" });
  expect(screen.queryByRole("region", { name: "Counter panel" })).not.toBeInTheDocument();
});

test("removal asks whether to keep preferences", async () => {
  const invoke = installFixtures(true);
  await useModStore.getState().load();
  render(<ModsSettings />);
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Keep preferences for a later reinstall" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
  await waitFor(() => expect(useModStore.getState().mods).toHaveLength(0));
  expect(invoke).toHaveBeenCalledWith("remove_mod", {
    id: "example.counter",
    keepPreferences: false,
  });
});

test("safe mode lets an enabled mod be persistently disabled", async () => {
  const invoke = installFixtures(true, true);
  await useModStore.getState().load();
  useModStore.setState((s) => ({
    safeMode: true,
    mods: s.mods.map((m) => ({ ...m, running: false })),
  }));
  render(<ModsSettings />);
  const toggle = screen.getByRole("switch", { name: "Enable Counter" });
  expect(toggle).toBeChecked();
  expect(toggle).toBeEnabled();
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("set_mod_enabled", {
      id: "example.counter",
      enabled: false,
    }),
  );
  await waitFor(() => expect(toggle).not.toBeChecked());
  expect(toggle).toBeDisabled();
});

test("saved mod defaults are reconciled after built-in effects register", async () => {
  installFixtures(true);
  await useModStore.getState().load();
  useModStore.setState((s) => ({
    mods: s.mods.map((m) => ({
      ...m,
      manifest: {
        ...m.manifest,
        commands: [{ id: "increment", title: "Increment counter", shortcut: "e x" }],
      },
    })),
  }));
  const archive = vi.fn();
  function Commands() {
    useCommands([{ id: "conversation.archive", title: "Archive", shortcut: "e", run: archive }]);
    useModCommands();
    return null;
  }
  render(<Commands />);
  await waitFor(() =>
    expect(registry.get("mod:example.counter:increment")?.shortcut).toBeUndefined(),
  );
  await act(() => registry.handleKeyDown(new KeyboardEvent("keydown", { key: "e" })));
  expect(archive).toHaveBeenCalledOnce();
});
