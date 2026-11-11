import { type RefObject, useEffect } from "react";
import { sidebarLayout, useUiStore } from "../store/uiStore";

/**
 * Keep the sidebar at its own width or out of the way: when the shell (`width`) has no room for
 * the sidebar plus `contentMin` beside it, the sidebar hides, and Show sidebar opens it over the
 * content, focused, until a press outside it, Escape (focus goes back) or Tab out of it.
 */
export function useSidebarFit(
  aside: RefObject<HTMLElement | null>,
  width: number,
  contentMin: number,
): "expanded" | "collapsed" | "overlay" {
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const layout = useUiStore(sidebarLayout);
  const squeezed = width > 0 && width - sidebarWidth < contentMin;

  useEffect(() => {
    useUiStore.getState().setSidebarSqueezed(squeezed);
  }, [squeezed]);
  useEffect(() => () => useUiStore.getState().setSidebarSqueezed(false), []);

  useEffect(() => {
    if (layout !== "overlay") return;
    const panel = aside.current;
    // Focus moves into the sidebar, and comes back to where it was on Escape.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = panel?.querySelector<HTMLElement>(
      'button:not([disabled]):not([tabindex="-1"]), a[href], input:not([disabled]), [tabindex="0"]',
    );
    first?.focus();
    const close = (restore: boolean) => {
      if (useUiStore.getState().sidebarPeek) useUiStore.getState().toggleSidebar();
      if (restore && opener?.isConnected) opener.focus();
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      // The Show sidebar button toggles it itself.
      if (panel?.contains(target) || target?.closest("[data-sidebar-toggle]")) return;
      close(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      }
    };
    // Tabbing out of it closes it: what's behind it would otherwise take focus unseen.
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null;
      if (next && !panel?.contains(next)) close(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    panel?.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      panel?.removeEventListener("focusout", onFocusOut);
    };
  }, [layout, aside]);

  return layout;
}
