import { type RefObject, useEffect } from "react";
import { sidebarLayout, useUiStore } from "../store/uiStore";

/**
 * Keep the sidebar at its own width or out of the way: when the shell (`width`) has no room for
 * the sidebar plus `contentMin` beside it, the sidebar hides, and Show sidebar opens it over the
 * content until a press outside it or Escape.
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
    const close = () => {
      if (useUiStore.getState().sidebarPeek) useUiStore.getState().toggleSidebar();
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      // The Show sidebar button toggles it itself.
      if (aside.current?.contains(target) || target?.closest("[data-sidebar-toggle]")) return;
      close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [layout, aside]);

  return layout;
}
