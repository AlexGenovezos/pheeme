import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { registry } from "../keyboard/registry";
import type { MessageDetail } from "../lib/tauri";
import { useThemeStore } from "../theme/theme";
import { EmailBody, MAX_FRAME_HEIGHT } from "./EmailBody";

const message = (over: Partial<MessageDetail> = {}): MessageDetail => ({
  id: "m1",
  threadId: "t1",
  fromName: "Mira Okafor",
  fromAddress: "mira@example.com",
  to: [],
  cc: [],
  subject: "Plan",
  snippet: "Hi",
  date: 1_700_000_000_000,
  bodyHtml: "<p>Hello <b>there</b></p>",
  hasRemoteContent: false,
  declaresDarkMode: false,
  bodyText: "Hello there",
  unread: false,
  starred: false,
  labelIds: ["INBOX"],
  hasAttachment: false,
  attachments: [],
  ...over,
});

/** A ResizeObserver jsdom lacks: records what is observed and lets the test fire it. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
  fire() {
    const entries = [...this.targets].map((target) => ({ target }) as ResizeObserverEntry);
    if (entries.length) this.callback(entries, this as unknown as ResizeObserver);
  }
  static fireAll() {
    act(() => FakeResizeObserver.instances.forEach((o) => o.fire()));
  }
}

let opened: string[];
const realResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
  opened = [];
  FakeResizeObserver.instances = [];
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  useThemeStore.setState({ resolved: "light" });
  mockIPC((cmd, args) => {
    if (cmd === "open_mail_link") opened.push((args as { url: string }).url);
    return undefined;
  });
});

afterEach(() => {
  globalThis.ResizeObserver = realResizeObserver;
});

const frame = () => screen.getByTitle("Message body") as HTMLIFrameElement;

/** jsdom doesn't load srcdoc, so put the body in the frame by hand and fire the load the browser would. */
function loadFrame(html: string, scrollHeight?: () => number) {
  const iframe = frame();
  const doc = iframe.contentDocument!;
  doc.body.innerHTML = html;
  if (scrollHeight) Object.defineProperty(doc.documentElement, "scrollHeight", { configurable: true, get: scrollHeight });
  fireEvent.load(iframe);
  return doc;
}

function click(doc: Document, selector: string) {
  const target = doc.querySelector(selector)!;
  const event = new doc.defaultView!.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  target.dispatchEvent(event);
  return event;
}

test("renders plain-text bodies linkified in the main document", () => {
  render(<EmailBody message={message({ bodyHtml: null, bodyText: "See https://example.com/a <b>now</b>" })} />);
  expect(screen.queryByTitle("Message body")).toBeNull();
  const text = document.querySelector(".message-card__text.selectable")!;
  expect(text.textContent).toBe("See https://example.com/a <b>now</b>");
  expect(screen.getByRole("button", { name: "https://example.com/a" })).toBeInTheDocument();
});

test("uses sandbox allow-same-origin only", () => {
  render(<EmailBody message={message()} />);
  const iframe = frame();
  expect(iframe.getAttribute("sandbox")).toBe("allow-same-origin");
  expect(iframe.getAttribute("srcdoc")).toContain("<body><p>Hello <b>there</b></p></body>");
  expect(iframe.getAttribute("srcdoc")).toContain('http-equiv="Content-Security-Policy"');
});

test("shows the load-images bar only with remote content, and clicking it rebuilds with https:", () => {
  const { unmount } = render(<EmailBody message={message()} />);
  expect(screen.queryByText("Images from the web are hidden.")).toBeNull();
  unmount();

  render(<EmailBody message={message({ hasRemoteContent: true })} />);
  expect(screen.getByText("Images from the web are hidden.")).toBeInTheDocument();
  expect(frame().getAttribute("srcdoc")).not.toContain("https:");

  fireEvent.click(screen.getByRole("button", { name: "Load images" }));
  expect(frame().getAttribute("srcdoc")).toContain("img-src data: pheeme-att: http://pheeme-att.localhost https: http:");
  expect(screen.queryByText("Images from the web are hidden.")).toBeNull();
});

test("clicking a link inside the frame calls open_mail_link and does not navigate", async () => {
  render(<EmailBody message={message()} />);
  const doc = loadFrame(
    '<a id="web" href="https://example.com/x?y=1"><span>go</span></a><a id="mail" href="mailto:a@b.c">mail</a>' +
      '<a id="js" href="javascript:alert(1)">js</a><a id="rel" href="/settings">rel</a><a id="none">none</a>',
  );

  expect(click(doc, "#web span").defaultPrevented).toBe(true);
  expect(click(doc, "#mail").defaultPrevented).toBe(true);
  // Anything else is blocked and not handed to the OS.
  expect(click(doc, "#js").defaultPrevented).toBe(true);
  expect(click(doc, "#rel").defaultPrevented).toBe(true);
  await act(async () => {});
  expect(opened).toEqual(["https://example.com/x?y=1", "mailto:a@b.c"]);

  // Middle-click opens nothing either.
  const aux = new doc.defaultView!.MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
  doc.querySelector("#web")!.dispatchEvent(aux);
  expect(aux.defaultPrevented).toBe(true);
  await act(async () => {});
  expect(opened).toEqual(["https://example.com/x?y=1", "mailto:a@b.c"]);
});

test("sizes the iframe to its content height", () => {
  render(<EmailBody message={message()} />);
  let content = 640;
  loadFrame("<p>Tall</p>", () => content);
  expect(frame().style.height).toBe("640px");

  // Content grows after load (an image arrives): the parent-side observer follows it.
  const observer = FakeResizeObserver.instances.find((o) => o.targets.has(frame().contentDocument!.documentElement));
  expect(observer).toBeDefined();
  content = 900;
  FakeResizeObserver.fireAll();
  expect(frame().style.height).toBe("900px");
});

const frameHeight = () => parseInt(frame().style.height, 10) || 0;

test("stops chasing content that grows with its own frame, and lets it scroll instead", () => {
  render(<EmailBody message={message()} />);
  // `height:200vh` plus a 40px footer: every resize makes the content twice as tall again.
  loadFrame("<div style='height:200vh'></div><p>Footer</p>", () => 2 * frameHeight() + 40);
  for (let i = 0; i < 50; i++) FakeResizeObserver.fireAll();
  const settled = frameHeight();
  // 40 on load, then at most MAX_SELF_GROWTH self-induced steps (120, 280, 600) before it pins.
  expect(settled).toBeLessThanOrEqual(600);
  for (let i = 0; i < 10; i++) FakeResizeObserver.fireAll();
  expect(frameHeight()).toBe(settled);
});

test("stops chasing constant growth too", () => {
  render(<EmailBody message={message()} />);
  loadFrame("<div style='height:100vh'></div><p>Footer</p>", () => (frameHeight() || 300) + 40);
  const first = frameHeight();
  for (let i = 0; i < 50; i++) FakeResizeObserver.fireAll();
  expect(frameHeight() - first).toBeLessThanOrEqual(40 * 3);
});

test("a tall email that settles after one resize renders at full height", () => {
  render(<EmailBody message={message()} />);
  // 8,000px of fixed-height content; scrollHeight is never less than the frame itself.
  let content = 8_000;
  loadFrame("<div style='height:8000px'></div>", () => Math.max(content, frameHeight()));
  for (let i = 0; i < 20; i++) FakeResizeObserver.fireAll();
  expect(frameHeight()).toBe(8_000);

  // Several separate content changes later (each settling) keep being followed: they aren't a loop.
  for (const next of [8_400, 8_900, 9_300, 9_800, 10_200]) {
    content = next;
    FakeResizeObserver.fireAll(); // the content grew
    FakeResizeObserver.fireAll(); // our resize settles
  }
  expect(frameHeight()).toBe(10_200);

  // An image arriving in the frame is the content's growth, even right after another growth.
  const doc = frame().contentDocument!;
  for (const next of [10_600, 11_000, 11_400, 11_800, 12_200]) {
    content = next;
    doc.body.dispatchEvent(new doc.defaultView!.Event("load"));
    FakeResizeObserver.fireAll();
  }
  expect(frameHeight()).toBe(12_200);
});

test("caps enormous bodies at MAX_FRAME_HEIGHT and lets them scroll", () => {
  render(<EmailBody message={message()} />);
  loadFrame("<div style='height:90000px'></div>", () => Math.max(90_000, frameHeight()));
  expect(frameHeight()).toBe(MAX_FRAME_HEIGHT);
  for (let i = 0; i < 5; i++) FakeResizeObserver.fireAll();
  expect(frameHeight()).toBe(MAX_FRAME_HEIGHT);
});

/** A keydown as the frame's document would deliver it. */
function press(doc: Document, target: Element, key: string, init: KeyboardEventInit = {}) {
  const event = new doc.defaultView!.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

test("shortcuts typed inside the frame reach the app's commands", () => {
  const next = vi.fn();
  const copy = vi.fn();
  const offs = [
    registry.register({ id: "test.next", title: "Next", shortcut: "j", run: next }),
    registry.register({ id: "test.open", title: "Open", shortcut: "enter", run: copy }),
  ];
  try {
    render(<EmailBody message={message()} />);
    const doc = loadFrame('<p id="text">Some text</p><a id="web" href="https://example.com/">go</a>');

    expect(press(doc, doc.querySelector("#text")!, "j").defaultPrevented).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);

    // Copy isn't a command, so it stays native (not prevented).
    expect(press(doc, doc.querySelector("#text")!, "c", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press(doc, doc.querySelector("#text")!, "c", { metaKey: true }).defaultPrevented).toBe(false);
  } finally {
    offs.forEach((off) => off());
  }
});

test("Enter on a focused link inside the frame activates it through the link interception", async () => {
  const enter = vi.fn();
  const off = registry.register({ id: "test.enter", title: "Open", shortcut: "enter", run: enter });
  try {
    render(<EmailBody message={message()} />);
    const doc = loadFrame('<a id="web" href="https://example.com/x">go</a>');
    const link = doc.querySelector<HTMLAnchorElement>("#web")!;
    link.focus();

    // The app doesn't take the key, so the browser's activation runs...
    expect(press(doc, link, "Enter").defaultPrevented).toBe(false);
    expect(enter).not.toHaveBeenCalled();
    // ...and that activation is a click, which goes to open_mail_link, not a navigation.
    expect(click(doc, "#web").defaultPrevented).toBe(true);
    await act(async () => {});
    expect(opened).toEqual(["https://example.com/x"]);
  } finally {
    off();
  }
});

test("theme changes re-render the srcdoc", () => {
  render(<EmailBody message={message()} />);
  expect(frame().getAttribute("srcdoc")).not.toContain("invert(");
  act(() => useThemeStore.setState({ resolved: "dark" }));
  expect(frame().getAttribute("srcdoc")).toContain("invert(1) hue-rotate(180deg)");
});

test("lets go of the old frame document when the srcdoc is rebuilt or the body unmounts", async () => {
  const { unmount } = render(<EmailBody message={message()} />);
  loadFrame('<a id="web" href="https://example.com/">go</a>');
  // jsdom keeps the same document across a srcdoc change, so a leaked listener would open the link twice.
  act(() => useThemeStore.setState({ resolved: "dark" }));
  const doc = loadFrame('<a id="web" href="https://example.com/">go</a>');
  click(doc, "#web");
  await act(async () => {});
  expect(opened).toEqual(["https://example.com/"]);
  expect(FakeResizeObserver.instances.filter((o) => o.targets.size > 0)).toHaveLength(1);

  // Same for keys: one listener, so the command runs once.
  const next = vi.fn();
  const off = registry.register({ id: "test.next", title: "Next", shortcut: "j", run: next });
  press(doc, doc.querySelector("#web")!, "j");
  off();
  expect(next).toHaveBeenCalledTimes(1);

  unmount();
  expect(FakeResizeObserver.instances.every((o) => o.targets.size === 0)).toBe(true);
});
