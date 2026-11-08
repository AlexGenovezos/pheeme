import { useRef, type CSSProperties } from "react";
import { useWidth } from "../lib/useWidth";
import { ColorPopoverHost } from "../labels/ColorPopover";
import { LabelDialogHost } from "../labels/LabelDialog";
import { LabelPickerHost } from "../labels/LabelPicker";
import { CategoryMoveHost } from "../mail/CategoryMoveDialog";
import { DragCardHost } from "../mail/dragMail";
import { PANE, useUiStore } from "../store/uiStore";
import { ChordHint } from "./ChordHint";
import { overlayTitleBar } from "./chrome";
import { Divider } from "./Divider";
import { ListPane } from "./ListPane";
import { Sidebar } from "./Sidebar";
import { ViewPane } from "./ViewPane";
import "./shell.css";

/**
 * Three panes: sidebar (collapsible), conversation list, reading view.
 * Widths live in the UI store (persisted) and reach CSS as variables; the grid
 * itself guarantees the minimums, so a narrow window never overlaps panes.
 * With the reading pane off, the list and the open conversation share one column,
 * and only one of them shows.
 */
export function AppShell({ onAddAccount }: { onAddAccount?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { sidebarWidth, listWidth, sidebarCollapsed, readingPane } = useUiStore();
  const conversationOpen = useUiStore((s) => s.openThread !== null);
  const { setSidebarWidth, setListWidth, resetSidebarWidth, resetListWidth } =
    useUiStore.getState();

  const width = useWidth(ref);
  const listSpace = width > 0 ? width - (sidebarCollapsed ? 0 : sidebarWidth) : 0;
  const listMax =
    listSpace > 0
      ? Math.max(PANE.listMin, listSpace - PANE.viewMin)
      : Math.max(listWidth, PANE.listMin);

  // The grid squeezes the list when the window shrinks; drags and arrow keys start from what's on screen.
  const renderedListWidth = Math.min(Math.max(listWidth, PANE.listMin), listMax);

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
      data-reading-pane={readingPane ? undefined : "off"}
      data-overlay-titlebar={overlayTitleBar || undefined}
    >
      <aside
        className="shell__sidebar"
        aria-label="Sidebar"
        aria-hidden={sidebarCollapsed || undefined}
      >
        <Sidebar onAddAccount={onAddAccount} />
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
      {/* Hidden rather than unmounted: the list keeps its scroll position and its j/k commands. */}
      <section
        className="shell__list"
        aria-label="Conversations"
        hidden={!readingPane && conversationOpen}
      >
        <ListPane />
      </section>
      {readingPane && (
        <Divider
          className="shell__divider--list"
          label="Resize conversation list"
          value={renderedListWidth}
          min={PANE.listMin}
          max={listMax}
          onResize={(w) => setListWidth(w, listSpace)}
          onReset={resetListWidth}
        />
      )}
      <main
        className="shell__view"
        aria-label="Reading pane"
        hidden={!readingPane && !conversationOpen}
      >
        <ViewPane />
      </main>
      <ChordHint />
      <LabelPickerHost />
      <CategoryMoveHost />
      <DragCardHost />
      <LabelDialogHost />
      <ColorPopoverHost />
    </div>
  );
}
