// @vitest-environment node
import { expect, test } from "vitest";
import type { AccountInfo } from "../lib/tauri";
import { clientLabel, groupByClient } from "./clientGroups";

const account = (id: string, clientId: string): AccountInfo => ({
  id,
  email: `${id}@example.com`,
  displayName: null,
  clientId,
  synced: true,
});

test("accounts on the same OAuth client share a group, in the order groups first appear", () => {
  const groups = groupByClient([account("a", "x"), account("b", "y"), account("c", "x")]);
  expect(groups.map((g) => [g.clientId, g.accounts.map((a) => a.id)])).toEqual([
    ["x", ["a", "c"]],
    ["y", ["b"]],
  ]);
});

test("a Google client ID is named by its project number and the end of its own part", () => {
  expect(clientLabel("418203915572-abc123preview8k2m.apps.googleusercontent.com")).toBe(
    "Project 418203915572 · client …8k2m",
  );
  expect(clientLabel("odd.apps.googleusercontent.com")).toBe("Client odd");
});
