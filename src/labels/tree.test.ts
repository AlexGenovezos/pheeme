import { describe, expect, test } from "vitest";
import type { LabelInfo } from "../lib/tauri";
import { buildLabelTree, filterSidebarTree, visibleInSidebar } from "./tree";

const label = (name: string, over: Partial<LabelInfo> = {}): LabelInfo => ({
  id: `id:${name}`,
  accountId: "a1",
  name,
  type: "user",
  messagesTotal: 0,
  messagesUnread: 0,
  threadsTotal: 0,
  threadsUnread: 0,
  colorBackground: null,
  colorText: null,
  messageListVisibility: "show",
  labelListVisibility: "labelShow",
  ...over,
});

test("tree_nests_by_slash", () => {
  const tree = buildLabelTree([label("Clients"), label("Clients/Acme"), label("Travel")]);
  expect(tree.map((n) => n.path)).toEqual(["Clients", "Travel"]);
  const acme = tree[0].children[0];
  expect(acme).toMatchObject({ path: "Clients/Acme", leaf: "Acme", depth: 1 });
  expect(acme.label?.name).toBe("Clients/Acme");
  expect(tree[0].depth).toBe(0);
});

test("tree_synthesizes_missing_parent", () => {
  const tree = buildLabelTree([label("Clients/Acme")]);
  expect(tree).toHaveLength(1);
  expect(tree[0]).toMatchObject({ label: null, path: "Clients", leaf: "Clients" });
  expect(tree[0].children[0].label?.name).toBe("Clients/Acme");
});

test("tree_sorts_case_insensitively", () => {
  const tree = buildLabelTree([
    label("beta"),
    label("Alpha"),
    label("Zed"),
    label("Zed/b"),
    label("Zed/A"),
  ]);
  expect(tree.map((n) => n.leaf)).toEqual(["Alpha", "beta", "Zed"]);
  expect(tree[2].children.map((n) => n.leaf)).toEqual(["A", "b"]);
});

test("tree ignores system labels", () => {
  expect(buildLabelTree([label("INBOX", { type: "system" })])).toEqual([]);
});

describe("visibility_rules", () => {
  test("by label list visibility", () => {
    expect(visibleInSidebar(label("a", { labelListVisibility: "labelHide" }), 5)).toBe(false);
    expect(visibleInSidebar(label("a", { labelListVisibility: "labelShowIfUnread" }), 0)).toBe(
      false,
    );
    expect(visibleInSidebar(label("a", { labelListVisibility: "labelShowIfUnread" }), 2)).toBe(
      true,
    );
    expect(visibleInSidebar(label("a", { labelListVisibility: "labelShow" }), 0)).toBe(true);
    expect(visibleInSidebar(label("a", { labelListVisibility: null }), 0)).toBe(true);
  });

  test("a parent stays visible when a descendant is", () => {
    const tree = buildLabelTree([
      label("P", { labelListVisibility: "labelHide" }),
      label("P/C"),
      label("Q", { labelListVisibility: "labelHide" }),
      label("Q/D", { labelListVisibility: "labelHide" }),
      label("R/E"),
    ]);
    const shown = filterSidebarTree(tree, () => 0);
    expect(shown.map((n) => n.path)).toEqual(["P", "R"]);
    expect(shown[0].children.map((n) => n.path)).toEqual(["P/C"]);
  });
});
