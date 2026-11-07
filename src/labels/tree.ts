// The label hierarchy: Gmail nests labels by `/` in their names.
import type { LabelInfo } from "../lib/tauri";

export interface LabelNode {
  /** `null` is a synthetic parent: a path segment with no label of its own. */
  label: LabelInfo | null;
  /** The full path, `Clients/Acme`. */
  path: string;
  /** The last segment, `Acme`. */
  leaf: string;
  depth: number;
  children: LabelNode[];
}

const byLeaf = (a: LabelNode, b: LabelNode) =>
  a.leaf.localeCompare(b.leaf, undefined, { sensitivity: "base" });

/** User labels as a tree, siblings sorted by leaf name; a sublabel whose parent doesn't exist gets a synthetic parent. */
export function buildLabelTree(labels: LabelInfo[]): LabelNode[] {
  const roots: LabelNode[] = [];
  const byPath = new Map<string, LabelNode>();
  const nodeFor = (path: string): LabelNode => {
    const found = byPath.get(path);
    if (found) return found;
    const cut = path.lastIndexOf("/");
    const node: LabelNode = {
      label: null,
      path,
      leaf: path.slice(cut + 1),
      depth: cut < 0 ? 0 : path.split("/").length - 1,
      children: [],
    };
    byPath.set(path, node);
    (cut < 0 ? roots : nodeFor(path.slice(0, cut)).children).push(node);
    return node;
  };
  for (const label of labels) {
    if (label.type === "user") nodeFor(label.name).label = label;
  }
  const sort = (nodes: LabelNode[]) => {
    nodes.sort(byLeaf);
    for (const n of nodes) sort(n.children);
  };
  sort(roots);
  return roots;
}

/** Whether the sidebar lists the label itself; `unread` is its unread conversations. */
export function visibleInSidebar(label: LabelInfo, unread: number): boolean {
  if (label.labelListVisibility === "labelHide") return false;
  if (label.labelListVisibility === "labelShowIfUnread") return unread > 0;
  return true;
}

/** Whether the label is set to Hide: unlike a quiet show-if-unread label, it takes its sublabels under More with it. */
const hiddenWithSublabels = (node: LabelNode) => node.label?.labelListVisibility === "labelHide";

/**
 * The nodes the sidebar shows. A hidden label leaves with its whole subtree; a show-if-unread parent with nothing
 * unread stays (as context) while any of its sublabels is shown.
 */
export function filterSidebarTree(
  nodes: LabelNode[],
  unreadOf: (label: LabelInfo) => number,
): LabelNode[] {
  return nodes.flatMap((node) => {
    if (hiddenWithSublabels(node)) return [];
    const children = filterSidebarTree(node.children, unreadOf);
    const own = node.label !== null && visibleInSidebar(node.label, unreadOf(node.label));
    return own || children.length > 0 ? [{ ...node, children }] : [];
  });
}

/**
 * The nodes the sidebar's More row holds: labels `filterSidebarTree` leaves out, under their parents (shown or not)
 * so a hidden sublabel still reads as part of its tree. A hidden label brings its whole subtree, nested as usual.
 */
export function hiddenSidebarTree(
  nodes: LabelNode[],
  unreadOf: (label: LabelInfo) => number,
): LabelNode[] {
  return nodes.flatMap((node) => {
    if (hiddenWithSublabels(node)) return [node];
    const children = hiddenSidebarTree(node.children, unreadOf);
    const hidden = node.label !== null && !visibleInSidebar(node.label, unreadOf(node.label));
    return hidden || children.length > 0 ? [{ ...node, children }] : [];
  });
}
