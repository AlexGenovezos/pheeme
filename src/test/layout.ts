// jsdom has no layout. These stubs give elements a size so virtualized lists render rows.
import { vi } from "vitest";

export interface LayoutStub {
  /** Height every element reports (the viewport for the list, the row height for rows). */
  viewport?: number;
  row?: number;
  width?: number;
}

/** Stub element sizes and ResizeObserver. Undone by `vi.restoreAllMocks()` / `vi.unstubAllGlobals()`. */
export function stubLayout({ viewport = 600, row = 76, width = 380 }: LayoutStub = {}) {
  const isRow = (el: Element) => el.hasAttribute("data-index");
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return isRow(this) ? row : viewport;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(width);
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return isRow(this) ? row : viewport;
  });
  vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const height = isRow(this) ? row : viewport;
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) };
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}
