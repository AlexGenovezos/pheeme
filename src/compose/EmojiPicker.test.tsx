import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { EditorBody, useComposeEditor } from "./Editor";
import { EmojiButton } from "./EmojiButton";
import EmojiPicker from "./EmojiPicker";
import { recentEmoji } from "./emoji";

beforeEach(() => {
  localStorage.clear();
  // jsdom doesn't scroll.
  Element.prototype.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
});

function picker() {
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(
    <EmojiPicker
      at={{ x: 0, y: 400 }}
      returnFocus={null}
      ignore={() => false}
      onPick={onPick}
      onClose={onClose}
    />,
  );
  return { onPick, onClose, search: screen.getByRole("searchbox", { name: "Search emoji" }) };
}

test("Enter puts in the first match and remembers it; modified Enter doesn't", () => {
  const { onPick, search } = picker();
  fireEvent.change(search, { target: { value: "thumbs up" } });
  fireEvent.keyDown(search, { key: "Enter", ctrlKey: true });
  expect(onPick).not.toHaveBeenCalled();
  fireEvent.keyDown(search, { key: "Enter" });
  expect(onPick).toHaveBeenCalledWith("👍");
  expect(recentEmoji()).toEqual(["👍"]);
});

test("a search with no match says so", () => {
  const { search } = picker();
  fireEvent.change(search, { target: { value: "zzzzqq" } });
  expect(screen.getByText("No emoji match.")).toBeInTheDocument();
});

test("arrow keys move through the grid, a click picks, Escape closes", () => {
  const { onPick, onClose, search } = picker();
  fireEvent.keyDown(search, { key: "ArrowDown" });
  const first = document.activeElement as HTMLElement;
  expect(first).toHaveAttribute("aria-label", "grinning face");
  fireEvent.keyDown(first, { key: "ArrowRight" });
  const second = document.activeElement as HTMLElement;
  expect(second).not.toBe(first);
  fireEvent.keyDown(second, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "ArrowDown" });
  fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
  // Up from the top row goes back to the search field.
  fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
  expect(document.activeElement).toBe(search);

  fireEvent.pointerEnter(first);
  fireEvent.click(first);
  expect(onPick).toHaveBeenCalledWith("😀");
  fireEvent.keyDown(search, { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});

test("recently used emoji come first, and a group tab clears the search", async () => {
  localStorage.setItem("pheeme.compose.recentEmoji", JSON.stringify(["🎉"]));
  const { search } = picker();
  expect(screen.getByRole("region", { name: "Recently used" })).toHaveTextContent("🎉");
  fireEvent.change(search, { target: { value: "cat" } });
  fireEvent.click(screen.getByRole("button", { name: "Animals & Nature" }));
  expect(search).toHaveValue("");
  await waitFor(() =>
    expect(screen.getByRole("region", { name: "Recently used" })).toBeInTheDocument(),
  );
});

let body = "";
function Compose() {
  const editor = useComposeEditor("<p>Hi</p>", (html) => (body = html));
  return (
    <>
      <EditorBody editor={editor} focusSeq={0} />
      <EmojiButton editor={editor} />
    </>
  );
}

test("the footer button opens the picker, which puts emoji in the text", async () => {
  render(<Compose />);
  const button = screen.getByRole("button", { name: "Insert emoji" });
  fireEvent.click(button);
  const search = await screen.findByRole("searchbox", { name: "Search emoji" });
  fireEvent.change(search, { target: { value: "party popper" } });
  fireEvent.keyDown(search, { key: "Enter" });
  expect(body).toContain("🎉");
  // Pressing the button again closes it.
  act(() => {
    fireEvent.pointerDown(button);
    fireEvent.click(button);
  });
  expect(screen.queryByRole("searchbox", { name: "Search emoji" })).toBeNull();
  expect(button).toHaveAttribute("aria-expanded", "false");
});
