import { describe, expect, test } from "vitest";
import type { LabelInfo } from "../lib/tauri";
import { buildLabelTree, filterSidebarTree, hiddenSidebarTree, visibleInSidebar } from "./tree";

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

  test("a quiet show-if-unread parent stays visible when a descendant is", () => {
    const tree = buildLabelTree([
      label("P", { labelListVisibility: "labelShowIfUnread" }),
      label("P/C"),
      label("Q", { labelListVisibility: "labelShowIfUnread" }),
      label("Q/D", { labelListVisibility: "labelHide" }),
      label("R/E"),
    ]);
    const shown = filterSidebarTree(tree, () => 0);
    expect(shown.map((n) => n.path)).toEqual(["P", "R"]);
    expect(shown[0].children.map((n) => n.path)).toEqual(["P/C"]);
  });
});

test("hidden_parent_takes_its_subtree_under_more", () => {
  const tree = buildLabelTree([
    label("test", { labelListVisibility: "labelHide" }),
    label("test/test 2"),
    label("test/test 2/deep", { labelListVisibility: "labelHide" }),
    label("test/news", { labelListVisibility: "labelShowIfUnread" }),
    label("Travel"),
  ]);
  // Unread mail doesn't bring a show-if-unread sublabel of a hidden parent back into the main list.
  expect(filterSidebarTree(tree, () => 5).map((n) => n.path)).toEqual(["Travel"]);
  const hidden = hiddenSidebarTree(tree, () => 5);
  expect(hidden.map((n) => n.path)).toEqual(["test"]);
  expect(hidden[0].children.map((n) => n.path)).toEqual(["test/news", "test/test 2"]);
  expect(hidden[0].children[1].children.map((n) => n.path)).toEqual(["test/test 2/deep"]);
});

test("hidden_tree_keeps_parents_of_hidden_labels", () => {
  const tree = buildLabelTree([
    label("Clients"),
    label("Clients/Acme", { labelListVisibility: "labelHide" }),
    label("Clients/Globex"),
    label("News", { labelListVisibility: "labelShowIfUnread" }),
    label("Travel"),
  ]);
  const hidden = hiddenSidebarTree(tree, () => 0);
  expect(hidden.map((n) => n.path)).toEqual(["Clients", "News"]);
  expect(hidden[0].children.map((n) => n.path)).toEqual(["Clients/Acme"]);
  expect(hiddenSidebarTree(tree, () => 1).map((n) => n.path)).toEqual(["Clients"]);
});
