import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { PANE, useUiStore } from "../store/uiStore";
import { ChordHint } from "./ChordHint";
import { overlayTitleBar } from "./chrome";
import { Divider } from "./Divider";
import { ListPane } from "./ListPane";
import { Sidebar } from "./Sidebar";
import { ViewPane } from "./ViewPane";
import "./shell.css";

/** Live width of an element (0 until measured, or where ResizeObserver is missing). */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/**
 * Three panes: sidebar (collapsible), conversation list, reading view.
 * Widths live in the UI store (persisted) and reach CSS as variables; the grid
 * itself guarantees the minimums, so a narrow window never overlaps panes.
 */
export function AppShell({ onManageAccounts }: { onManageAccounts?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { sidebarWidth, listWidth, sidebarCollapsed } = useUiStore();
  const { setSidebarWidth, setListWidth, resetSidebarWidth, resetListWidth } = useUiStore.getState();

  const width = useWidth(ref);
  const listSpace = width > 0 ? width - (sidebarCollapsed ? 0 : sidebarWidth) : 0;
  const listMax = listSpace > 0 ? Math.max(PANE.listMin, listSpace - PANE.viewMin) : Math.max(listWidth, PANE.listMin);

  const style = {
    "--shell-sidebar-w": `${sidebarWidth}px`,
    "--shell-list-w": `${listWidth}px`,
    "--shell-list-min": `${PANE.listMin}px`,
    "--shell-view-min": `${PANE.viewMin}px`,
  } as CSSProperties;

  return (
    <div
      ref={ref}
      className="shell"
      style={style}
      data-sidebar={sidebarCollapsed ? "collapsed" : "expanded"}
      data-overlay-titlebar={overlayTitleBar || undefined}
    >
      <aside className="shell__sidebar" aria-label="Sidebar" aria-hidden={sidebarCollapsed || undefined}>
        <Sidebar onManageAccounts={onManageAccounts} />
      </aside>
      {!sidebarCollapsed && (
        <Divider
          className="shell__divider--sidebar"
          label="Resize sidebar"
          value={sidebarWidth}
          min={PANE.sidebarMin}
          max={PANE.sidebarMax}
          onResize={setSidebarWidth}
          onReset={resetSidebarWidth}
        />
      )}
      <section className="shell__list" aria-label="Conversations">
        <ListPane />
      </section>
      <Divider
        className="shell__divider--list"
        label="Resize conversation list"
        value={listWidth}
        min={PANE.listMin}
        max={listMax}
        onResize={(w) => setListWidth(w, listSpace)}
        onReset={resetListWidth}
      />
      <main className="shell__view" aria-label="Reading pane">
        <ViewPane />
      </main>
      <ChordHint />
    </div>
  );
}
