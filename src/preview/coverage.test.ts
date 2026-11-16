// @vitest-environment node
import { expect, test } from "vitest";
import { createPreviewHandlers } from "./install";

// Typecheck already proves the preview answers every command (`PreviewHandlers` is `CommandHandlers`).
test("a mod connection is connected, then disconnected", () => {
  const handlers = createPreviewHandlers("?mods=1");
  const args = { id: "example.counter", connection: "google", clientId: "1.apps" };
  expect(handlers.mod_connection_status(args)).toBe(false);
  handlers.connect_mod(args);
  expect(handlers.mod_connection_status(args)).toBe(true);
  handlers.disconnect_mod(args);
  expect(handlers.mod_connection_status(args)).toBe(false);
});
