import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { showContextMenu, toAccelerator, useContextMenuStore } from "../../lib/contextMenu";
import { ContextMenuHost } from "../../shell/ContextMenuHost";
import { Avatar, avatarColorIndex, initialsFor } from "./Avatar";
import { Badge } from "./Badge";
import { IconButton } from "./IconButton";
import { Menu } from "./Menu";
import { ToastProvider, toast, useToastStore } from "./Toast";

afterEach(() => {
  useToastStore.setState({ toasts: [] });
  useContextMenuStore.setState({ open: null });
});

describe("Avatar", () => {
  test("initials from names and addresses", () => {
    expect(initialsFor("Mira Okafor")).toBe("MO");
    expect(initialsFor("notifications@github.com")).toBe("N");
    expect(initialsFor("jonas.weber@posteo.de")).toBe("JW");
    expect(initialsFor("Ánh Lê")).toBe("ÁL");
    expect(initialsFor("")).toBe("?");
  });

  test("color is stable per sender", () => {
    expect(avatarColorIndex("mira@northlight.studio")).toBe(
      avatarColorIndex("MIRA@northlight.studio"),
    );
    expect(avatarColorIndex("x")).toBeGreaterThanOrEqual(1);
  });

  test("falls back to initials when the image fails", () => {
    render(<Avatar name="Sam Lindqvist" src="https://example.invalid/a.png" />);
    fireEvent.error(screen.getByRole("img", { name: "Sam Lindqvist" }).querySelector("img")!);
    expect(screen.getByText("SL")).toBeInTheDocument();
  });
});

test("Badge caps large counts", () => {
  render(<Badge count={12345} />);
  expect(screen.getByText("999+")).toBeInTheDocument();
});

test("IconButton names itself and shows the shortcut in its tooltip", () => {
  render(<IconButton label="Archive" shortcut="e" icon={<svg />} />);
  expect(screen.getByRole("button", { name: "Archive" })).toHaveAttribute("title", "Archive (E)");
});

describe("Menu", () => {
  test("arrow keys skip separators and disabled items; Enter chooses", () => {
    const onClose = vi.fn();
    const a = vi.fn();
    const c = vi.fn();
    render(
      <Menu
        x={0}
        y={0}
        onClose={onClose}
        items={[
          { id: "a", label: "Alpha", onSelect: a },
          { type: "separator" },
          { id: "b", label: "Beta", disabled: true, onSelect: vi.fn() },
          { id: "c", label: "Gamma", onSelect: c },
        ]}
      />,
    );
    const menu = screen.getByRole("menu");
    expect(menu).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(c).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
    expect(a).not.toHaveBeenCalled();
  });

  test("Escape and outside clicks close it", () => {
    const onClose = vi.fn();
    render(
      <Menu
        x={0}
        y={0}
        onClose={onClose}
        items={[{ id: "a", label: "Alpha", onSelect: vi.fn() }]}
      />,
    );
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("context menus", () => {
  test("browser preview shows a DOM menu at the requested point", async () => {
    render(<ContextMenuHost />);
    await act(() =>
      showContextMenu([{ id: "x", label: "Reply", checked: true, onSelect: vi.fn() }], {
        x: 40,
        y: 50,
      }),
    );
    expect(screen.getByRole("menuitemcheckbox", { name: "Reply" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menu")).toHaveStyle({ left: "40px", top: "50px" });
  });

  test("only simple shortcuts become native accelerators", () => {
    expect(toAccelerator("mod+shift+l")).toBe("CmdOrCtrl+Shift+L");
    expect(toAccelerator("e")).toBe("E");
    expect(toAccelerator("g i")).toBeUndefined();
    expect(toAccelerator("#")).toBeUndefined();
  });
});

describe("Toast", () => {
  test("shows, runs its action, and auto-dismisses", () => {
    vi.useFakeTimers();
    const undo = vi.fn();
    render(<ToastProvider />);
    act(() => void toast({ title: "Archived", action: { label: "Undo", run: undo } }));
    expect(screen.getByRole("status")).toHaveTextContent("Archived");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalled();
    expect(screen.queryByText("Archived")).not.toBeInTheDocument();

    act(() => void toast({ title: "Sent" }));
    act(() => void vi.advanceTimersByTime(4001));
    expect(screen.queryByText("Sent")).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});
