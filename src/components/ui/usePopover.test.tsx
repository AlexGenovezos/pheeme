import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, test, vi } from "vitest";
import { trapTab } from "./useDialogFocus";
import { usePopover } from "./usePopover";

function Panel({
  onClose,
  closeOnBlur,
  at = { x: 10, y: 20 },
}: {
  onClose(): void;
  closeOnBlur?: boolean;
  at?: { x: number; y: number };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { pos } = usePopover({ ref, at, onClose, closeOnBlur });
  return (
    <div ref={ref} tabIndex={-1} data-testid="panel" style={{ left: pos.x, top: pos.y }}>
      <button>inside</button>
    </div>
  );
}

describe("usePopover", () => {
  test("focuses the panel and gives focus back to the opener when it closes", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(<Panel onClose={vi.fn()} />);
    expect(screen.getByTestId("panel")).toHaveFocus();
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  test("closes on a press outside, not inside", () => {
    const onClose = vi.fn();
    render(<Panel onClose={onClose} />);
    fireEvent.pointerDown(screen.getByText("inside"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("closes when the window loses focus, unless told not to", () => {
    const stays = vi.fn();
    const { unmount } = render(<Panel onClose={stays} closeOnBlur={false} />);
    fireEvent.blur(window);
    expect(stays).not.toHaveBeenCalled();
    unmount();
    const closes = vi.fn();
    render(<Panel onClose={closes} />);
    fireEvent.blur(window);
    expect(closes).toHaveBeenCalledTimes(1);
  });

  test("calls the newest onClose without rebinding on every render", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Panel onClose={first} />);
    rerender(<Panel onClose={second} />);
    fireEvent.pointerDown(document.body);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("trapTab", () => {
  function Dialog() {
    return (
      <div tabIndex={-1} data-testid="dialog">
        <button>first</button>
        <button>last</button>
      </div>
    );
  }

  test("wraps Tab from the last control and Shift+Tab from the first", () => {
    render(<Dialog />);
    const dialog = screen.getByTestId("dialog");
    const [first, last] = [screen.getByText("first"), screen.getByText("last")];
    last.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    trapTab(tab as never, dialog);
    expect(tab.defaultPrevented).toBe(true);
    expect(first).toHaveFocus();
    const back = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true });
    trapTab(back as never, dialog);
    expect(back.defaultPrevented).toBe(true);
    expect(last).toHaveFocus();
  });

  test("leaves Tab between controls to the browser", () => {
    render(<Dialog />);
    screen.getByText("first").focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    trapTab(tab as never, screen.getByTestId("dialog"));
    expect(tab.defaultPrevented).toBe(false);
  });
});
