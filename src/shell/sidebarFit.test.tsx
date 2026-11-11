import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { beforeEach, expect, test } from "vitest";
import { __resetUiStoreForTests, useUiStore } from "../store/uiStore";
import { useSidebarFit } from "./sidebarFit";

beforeEach(() => {
  localStorage.clear();
  __resetUiStoreForTests();
});

/** A shell `width` px wide whose content needs 400 px beside the sidebar. */
function Shell({ width }: { width: number }) {
  const aside = useRef<HTMLElement>(null);
  const layout = useSidebarFit(aside, width, 400);
  return (
    <div data-layout={layout} data-testid="shell">
      <aside ref={aside}>
        <button type="button">Inbox</button>
      </aside>
      <button
        type="button"
        data-sidebar-toggle=""
        onClick={() => useUiStore.getState().toggleSidebar()}
      >
        Show sidebar
      </button>
      <button type="button">Archive</button>
    </div>
  );
}

const layout = () => screen.getByTestId("shell").dataset.layout;

test("with room the sidebar sits beside the content; without, it hides", () => {
  const { rerender } = render(<Shell width={1000} />);
  expect(layout()).toBe("expanded");
  rerender(<Shell width={500} />);
  expect(layout()).toBe("collapsed");
});

test("opened over the content it takes focus; Escape closes it and gives focus back", () => {
  render(<Shell width={500} />);
  const opener = screen.getByRole("button", { name: "Show sidebar" });
  opener.focus();
  act(() => opener.click());
  expect(layout()).toBe("overlay");
  expect(screen.getByRole("button", { name: "Inbox" })).toHaveFocus();

  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(layout()).toBe("collapsed");
  expect(opener).toHaveFocus();
});

test("tabbing out of it, or pressing outside it, closes it", () => {
  render(<Shell width={500} />);
  act(() => screen.getByRole("button", { name: "Show sidebar" }).click());
  const inbox = screen.getByRole("button", { name: "Inbox" });
  const archive = screen.getByRole("button", { name: "Archive" });
  fireEvent.focusOut(inbox, { relatedTarget: archive });
  expect(layout()).toBe("collapsed");

  act(() => screen.getByRole("button", { name: "Show sidebar" }).click());
  expect(layout()).toBe("overlay");
  fireEvent.pointerDown(archive);
  expect(layout()).toBe("collapsed");
});
