import { act, fireEvent, render } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { platform } from "../../lib/platform";
import { useSandboxedFrame } from "./sandboxedFrame";

function TestFrame({
  data,
  onFrameKeyDown,
  onFrameFocus,
}: {
  data: ArrayBuffer;
  onFrameKeyDown?: (e: KeyboardEvent) => void;
  onFrameFocus?: () => void;
}) {
  const { frame } = useSandboxedFrame(
    data,
    onFrameKeyDown,
    onFrameFocus,
    (doc) => {
      doc.body.innerHTML = "<p id='slide'>Slide text</p>";
      return { done: Promise.resolve() };
    },
    () => "<!doctype html><html><body></body></html>",
  );
  return <iframe ref={frame} sandbox="allow-same-origin" title="test" />;
}

test("when frame listeners run (Chromium), keydown forwards in capture phase without stealing focus", async () => {
  vi.useFakeTimers();
  try {
    const onKeyDown = vi.fn();
    const onFocus = vi.fn();
    const { container } = render(
      <TestFrame data={new ArrayBuffer(1)} onFrameKeyDown={onKeyDown} onFrameFocus={onFocus} />,
    );
    const iframe = container.querySelector("iframe")!;
    const doc = iframe.contentDocument!;
    const slide = doc.getElementById("slide")!;
    // Even if an inner element stops propagation in bubble phase, capture still sees the key.
    slide.addEventListener("keydown", (e) => e.stopPropagation());
    slide.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(onKeyDown.mock.calls[0][0].key).toBe("Escape");

    iframe.focus();
    act(() => {
      window.dispatchEvent(new Event("blur"));
      vi.runAllTimers();
    });
    expect(onFocus).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("when frame listeners are blocked (WebKit), focus returns on blur and mod+c copies the frame selection", async () => {
  vi.useFakeTimers();
  try {
    const onKeyDown = vi.fn();
    const onFocus = vi.fn();
    const { container, rerender } = render(
      <TestFrame data={new ArrayBuffer(1)} onFrameKeyDown={onKeyDown} onFrameFocus={onFocus} />,
    );
    const iframe = container.querySelector("iframe")!;
    const doc = iframe.contentDocument!;
    // Rewrite the frame with listeners on its document blocked, as WebKit does for a script-less sandbox.
    const orig = doc.dispatchEvent.bind(doc);
    doc.dispatchEvent = (e: Event) => (e.type === "pheeme-probe" ? true : orig(e));
    rerender(
      <TestFrame data={new ArrayBuffer(2)} onFrameKeyDown={onKeyDown} onFrameFocus={onFocus} />,
    );

    iframe.focus();
    expect(document.activeElement).toBe(iframe);
    act(() => {
      window.dispatchEvent(new Event("blur"));
      vi.runAllTimers();
    });
    expect(onFocus).toHaveBeenCalledTimes(1);

    doc.execCommand = vi.fn(() => true);
    doc.getSelection()!.selectAllChildren(doc.body);
    const mod = platform === "macos" ? { metaKey: true } : { ctrlKey: true };
    expect(fireEvent.keyDown(document.body, { key: "c", ...mod })).toBe(false);
    expect(doc.execCommand).toHaveBeenCalledWith("copy");
  } finally {
    vi.useRealTimers();
  }
});
