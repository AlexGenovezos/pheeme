import { Menu } from "../components/ui/Menu";
import { closeDomMenu, useContextMenuStore } from "../lib/contextMenu";

/** Renders the DOM fallback for showContextMenu(). Mount once. */
export function ContextMenuHost() {
  const open = useContextMenuStore((s) => s.open);
  if (!open) return null;
  return <Menu key={open.seq} items={open.items} x={open.x} y={open.y} onClose={closeDomMenu} />;
}
