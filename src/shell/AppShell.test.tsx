import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  __resetUiStoreForTests,
  clampList,
  LAYOUT_KEY,
  PANE,
  readLayout,
  useUiStore,
} from "../store/uiStore";
import { AppShell } from "./AppShell";

// jsdom has no PointerEvent; a MouseEvent subclass carries clientX the same way.
beforeAll(() => {
  if (!("PointerEvent" in window)) {
    class PointerEventPolyfill extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    Object.assign(window, { PointerEvent: PointerEventPolyfill });
  }
});

beforeEach(() => {
  localStorage.clear();
  __resetUiStoreForTests();
  mockIPC(() => undefined, { shouldMockEvents: true });
});

const stored = () => JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null");
const shell = (container: HTMLElement) => container.querySelector<HTMLElement>(".shell")!;

describe("pane dividers", () => {
  test("dragging the list divider resizes the list and persists the width", () => {
    const { container } = render(<AppShell />);
    const divider = screen.getByRole("separator", { name: "Resize conversation list" });
    fireEvent.pointerDown(divider, { button: 0, clientX: 600 });
    fireEvent.pointerMove(divider, { clientX: 640 });
    fireEvent.pointerUp(divider, { clientX: 640 });
    expect(useUiStore.getState().listWidth).toBe(PANE.listDefault + 40);
    expect(stored()).toMatchObject({ listWidth: PANE.listDefault + 40 });
    expect(shell(container).style.getPropertyValue("--shell-list-w")).toBe(
      `${PANE.listDefault + 40}px`,
    );
    expect(document.body.dataset.resizing).toBeUndefined();
  });

  test("the sidebar divider clamps to its range", () => {
    render(<AppShell />);
    const divider = screen.getByRole("separator", { name: "Resize sidebar" });
    fireEvent.pointerDown(divider, { button: 0, clientX: 220 });
    fireEvent.pointerMove(divider, { clientX: 1000 });
    fireEvent.pointerUp(divider);
    expect(stored()).toMatchObject({ sidebarWidth: PANE.sidebarMax });
    fireEvent.pointerDown(divider, { button: 0, clientX: 320 });
    fireEvent.pointerMove(divider, { clientX: 0 });
    fireEvent.pointerUp(divider);
    expect(stored()).toMatchObject({ sidebarWidth: PANE.sidebarMin });
  });

  test("keyboard: arrows resize, Enter resets", () => {
    render(<AppShell />);
    const divider = screen.getByRole("separator", { name: "Resize sidebar" });
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(divider).toHaveAttribute("aria-valuenow", String(PANE.sidebarDefault + 16));
    fireEvent.keyDown(divider, { key: "Enter" });
    expect(divider).toHaveAttribute("aria-valuenow", String(PANE.sidebarDefault));
  });

  test("after the window shrinks, dragging starts from the rendered list width", () => {
    // A 1000 px window with a 220 px sidebar leaves room for a 380 px list (view min 400).
    class FixedWidthObserver {
      constructor(private cb: ResizeObserverCallback) {}
      observe() {
        this.cb(
          [{ contentRect: { width: 1000 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      disconnect() {}
    }
    const original = window.ResizeObserver;
    window.ResizeObserver = FixedWidthObserver as unknown as typeof ResizeObserver;
    try {
      localStorage.setItem(
        LAYOUT_KEY,
        JSON.stringify({ sidebarWidth: 220, listWidth: 660, sidebarCollapsed: false }),
      );
      __resetUiStoreForTests();
      render(<AppShell />);
      const divider = screen.getByRole("separator", { name: "Resize conversation list" });
      expect(divider).toHaveAttribute("aria-valuenow", "380");
      fireEvent.pointerDown(divider, { button: 0, clientX: 600 });
      fireEvent.pointerMove(divider, { clientX: 560 });
      fireEvent.pointerUp(divider, { clientX: 560 });
      expect(useUiStore.getState().listWidth).toBe(340);
    } finally {
      window.ResizeObserver = original;
    }
  });

  test("a stored layout is restored on launch", () => {
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({ sidebarWidth: 260, listWidth: 420, sidebarCollapsed: true }),
    );
    __resetUiStoreForTests();
    const { container } = render(<AppShell />);
    expect(shell(container).dataset.sidebar).toBe("collapsed");
    expect(shell(container).style.getPropertyValue("--shell-sidebar-w")).toBe("260px");
    expect(shell(container).style.getPropertyValue("--shell-list-w")).toBe("420px");
    expect(screen.queryByRole("separator", { name: "Resize sidebar" })).not.toBeInTheDocument();
  });
});

describe("layout storage", () => {
  test("corrupt or out-of-range values fall back safely", () => {
    localStorage.setItem(LAYOUT_KEY, "{not json");
    expect(readLayout()).toEqual({
      sidebarWidth: 220,
      listWidth: PANE.listDefault,
      sidebarCollapsed: false,
      listDensity: "comfortable",
    });
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ sidebarWidth: 9999, listWidth: 10 }));
    expect(readLayout()).toMatchObject({ sidebarWidth: PANE.sidebarMax, listWidth: PANE.listMin });
  });

  test("the list never squeezes the reading pane below its minimum", () => {
    expect(clampList(2000, 1000)).toBe(1000 - PANE.viewMin);
    expect(clampList(100, 1000)).toBe(PANE.listMin);
  });

  test("collapsing the sidebar persists", () => {
    render(<AppShell />);
    fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
    expect(stored()).toMatchObject({ sidebarCollapsed: true });
    fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    expect(stored()).toMatchObject({ sidebarCollapsed: false });
  });
});
