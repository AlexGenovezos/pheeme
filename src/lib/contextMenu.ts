import { LogicalPosition } from "@tauri-apps/api/dpi";
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { create } from "zustand";
import type { MenuItem as MenuItemSpec } from "../components/ui/Menu";
import { parseShortcut } from "../keyboard/registry";
import { isTauri } from "../preview/runtime";

export type ContextMenuItem = MenuItemSpec;

interface OpenMenu {
  /** Changes per open so a re-opened menu starts fresh. */
  seq: number;
  items: ContextMenuItem[];
  x: number;
  y: number;
}

/** The DOM fallback menu currently showing, if any (rendered by ContextMenuHost). */
export const useContextMenuStore = create<{ open: OpenMenu | null }>(() => ({ open: null }));

export const closeDomMenu = () => useContextMenuStore.setState({ open: null });

/**
 * Native menus show the shortcut as an accelerator label. Only simple
 * single-step shortcuts are passed through; chords ("g i") and symbols have no
 * accelerator form, and one invalid accelerator would fail the whole menu.
 */
export function toAccelerator(shortcut: string | undefined): string | undefined {
  if (!shortcut) return undefined;
  const steps = parseShortcut(shortcut);
  if (steps.length !== 1 || !/^[a-z0-9]$/.test(steps[0].key)) return undefined;
  const s = steps[0];
  return [
    s.mod && "CmdOrCtrl",
    s.meta && "Super",
    s.ctrl && "Ctrl",
    s.alt && "Alt",
    s.shift && "Shift",
    s.key.toUpperCase(),
  ]
    .filter(Boolean)
    .join("+");
}

let seq = 0;
/** The last native menu and its items. GTK popups return before they close, so they stay alive until the next menu. */
let lastNative: Array<{ close(): Promise<void> }> = [];

async function showNative(items: ContextMenuItem[], at?: { x: number; y: number }) {
  // Free the previous menu's Rust resources (menu and items) before new items reuse their ids.
  const previous = lastNative;
  lastNative = [];
  await Promise.all(previous.map((r) => r.close().catch(() => {})));
  const built = await Promise.all(
    items.map((item) => {
      if (item.type === "separator") return PredefinedMenuItem.new({ item: "Separator" });
      const common = {
        id: item.id,
        text: item.label,
        enabled: !item.disabled,
        accelerator: toAccelerator(item.shortcut),
        action: () => item.onSelect(),
      };
      return item.checked != null
        ? CheckMenuItem.new({ ...common, checked: item.checked })
        : MenuItem.new(common);
    }),
  );
  const menu = await Menu.new({ items: built });
  lastNative = [menu, ...built];
  await menu.popup(at ? new LogicalPosition(at.x, at.y) : undefined);
}

/**
 * Show a menu: native in the desktop app, a DOM menu in browser preview (or if
 * the native one fails). `at` is in viewport coordinates; omit it to open at
 * the pointer (native) — the DOM fallback then uses the top-left corner.
 */
export async function showContextMenu(items: ContextMenuItem[], at?: { x: number; y: number }): Promise<void> {
  if (isTauri()) {
    try {
      await showNative(items, at);
      return;
    } catch (err) {
      console.warn("native menu failed; using DOM menu", err);
    }
  }
  useContextMenuStore.setState({ open: { seq: ++seq, items, x: at?.x ?? 0, y: at?.y ?? 0 } });
}

/** `onContextMenu` helper: suppress the webview menu and show ours at the pointer. */
export function openContextMenuFromEvent(
  e: { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number },
  items: ContextMenuItem[],
) {
  e.preventDefault();
  e.stopPropagation();
  void showContextMenu(items, { x: e.clientX, y: e.clientY });
}
