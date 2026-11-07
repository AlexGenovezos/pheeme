import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { registry } from "../keyboard/registry";
import type { MessageDetail, ThreadDetail } from "../lib/tauri";
import { useSettingsStore } from "../settings/settingsStore";
import { useThreadStore } from "../store/threadStore";
import { __resetUiStoreForTests, useUiStore } from "../store/uiStore";
import { speedReadOpenConversation, useSpeedReader } from "./open";
import { DEFAULT_PREFS, SPEED_READER_KEY, useSpeedReaderSettings } from "./settings";
import { SpeedReaderHost } from "./SpeedReader";

const word = () => {
  const el = document.querySelector(".speed-reader__word");
  return el?.textContent ?? "";
};
const focusLetter = () => document.querySelector(".speed-reader__focus")?.textContent;
const dialog = () => screen.getByRole("dialog", { name: /Speed read/ });

function openReader(paragraphs = ["One two three.", "Four five"]) {
  act(() => useSpeedReader.getState().open({ id: "m1", title: "A letter", paragraphs }));
}

beforeEach(() => {
  localStorage.clear();
  registry.clear();
  __resetUiStoreForTests();
  useSpeedReader.setState({ session: null });
  useSpeedReaderSettings.setState({ ...DEFAULT_PREFS, pauses: false, wpm: 300 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SpeedReader", () => {
  test("shows the first word, its focus letter coloured, and how far there is to go", () => {
    render(<SpeedReaderHost />);
    openReader();
    expect(word()).toBe("One");
    expect(focusLetter()).toBe("n");
    expect(dialog()).toHaveTextContent("1 / 5 words");
    expect(dialog()).toHaveTextContent("Press Space to start");
  });

  test("Space plays word by word at the chosen speed, and stops on the last word", () => {
    vi.useFakeTimers();
    render(<SpeedReaderHost />);
    openReader();
    fireEvent.keyDown(dialog(), { key: " " });
    act(() => vi.advanceTimersByTime(200)); // 300 wpm = 200 ms a word
    expect(word()).toBe("two");
    // Each word schedules the next once it shows, so step a word at a time.
    for (let i = 0; i < 4; i++) act(() => vi.advanceTimersByTime(200));
    expect(word()).toBe("five");
    expect(screen.getByRole("button", { name: "Read again" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Read again" }));
    expect(word()).toBe("One");
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  test("Space on another button presses that button rather than playing", () => {
    render(<SpeedReaderHost />);
    openReader();
    fireEvent.keyDown(screen.getByRole("button", { name: /^450 words per minute/ }), { key: " " });
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "Play" }), { key: " " });
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  test("arrow keys step through words and change the speed, which is remembered", () => {
    render(<SpeedReaderHost />);
    openReader();
    fireEvent.keyDown(dialog(), { key: "ArrowRight" });
    fireEvent.keyDown(dialog(), { key: "ArrowRight" });
    expect(word()).toBe("three.");
    fireEvent.keyDown(dialog(), { key: "ArrowLeft" });
    expect(word()).toBe("two");
    fireEvent.keyDown(dialog(), { key: "ArrowUp" });
    expect(useSpeedReaderSettings.getState().wpm).toBe(325);
    expect(screen.getByRole("slider", { name: "Reading speed" })).toHaveValue("325");
    expect(JSON.parse(localStorage.getItem(SPEED_READER_KEY)!).wpm).toBe(325);
  });

  test("speed presets and options change the settings while reading", () => {
    render(<SpeedReaderHost />);
    openReader();
    fireEvent.click(screen.getByRole("button", { name: "450 words per minute, Advanced" }));
    expect(useSpeedReaderSettings.getState().wpm).toBe(450);
    expect(screen.getByRole("button", { name: /^450 words/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Smaller words" }));
    expect(useSpeedReaderSettings.getState().size).toBe("medium");

    fireEvent.click(screen.getByRole("button", { name: "Reading options" }));
    fireEvent.click(screen.getByRole("switch", { name: "Pause at punctuation" }));
    expect(useSpeedReaderSettings.getState().pauses).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Large" }));
    expect(useSpeedReaderSettings.getState().size).toBe("large");
  });

  test("Escape closes the options first, then the reader; the options link opens Settings", () => {
    render(<SpeedReaderHost />);
    openReader();
    fireEvent.click(screen.getByRole("button", { name: "Reading options" }));
    fireEvent.keyDown(screen.getByRole("switch", { name: "Pause at punctuation" }), {
      key: "Escape",
    });
    expect(screen.queryByRole("group", { name: "Reading options" })).toBeNull();
    expect(dialog()).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reading options" }));
    fireEvent.click(screen.getByRole("button", { name: "All speed reader settings…" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useSettingsStore.getState()).toMatchObject({ open: true, page: "appearance" });
  });

  test("Escape closes it, and app shortcuts are paused while it's open", () => {
    const archive = vi.fn();
    const off = registry.register({
      id: "conversation.archive",
      title: "Archive",
      shortcut: "e",
      run: archive,
    });
    render(<SpeedReaderHost />);
    openReader();
    registry.handleKeyDown(new KeyboardEvent("keydown", { key: "e" }));
    expect(archive).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    registry.handleKeyDown(new KeyboardEvent("keydown", { key: "e" }));
    expect(archive).toHaveBeenCalledTimes(1);
    off();
  });
});

describe("speedReadOpenConversation", () => {
  const message = (id: string, bodyText: string): MessageDetail => ({
    id,
    threadId: "t1",
    fromName: "Matt",
    fromAddress: "matt@example.com",
    to: [],
    cc: [],
    subject: "Interesting read",
    snippet: null,
    date: 0,
    bodyHtml: null,
    hasRemoteContent: false,
    declaresDarkMode: false,
    bodyText,
    bodyAvailable: true,
    unread: false,
    starred: false,
    labelIds: ["INBOX"],
    hasAttachment: false,
    attachments: [],
  });

  function openThread(messages: MessageDetail[]) {
    const detail = { thread: { subject: "Interesting read" }, messages, bodyError: null };
    useThreadStore.setState({ details: new Map([["a1:t1", detail as unknown as ThreadDetail]]) });
    useUiStore.setState({ openThread: "a1:t1" });
  }

  test("opens the newest message that is simple prose", () => {
    const long = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
    openThread([message("m1", long), message("m2", "Thanks!")]);
    speedReadOpenConversation();
    expect(useSpeedReader.getState().session).toMatchObject({
      id: "m1",
      title: "Interesting read",
    });
  });

  test("says so when there's nothing simple enough to read", () => {
    openThread([message("m2", "Thanks!")]);
    speedReadOpenConversation();
    expect(useSpeedReader.getState().session).toBeNull();
  });
});
