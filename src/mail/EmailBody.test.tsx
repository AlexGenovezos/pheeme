import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { registry } from "../keyboard/registry";
import { platform } from "../lib/platform";
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
  bodyAvailable: true,
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

/**
 * Swap the written body for test content (jsdom has no layout, so `scrollHeight` comes from the test) and
 * tell the frame its content changed, as an image arriving would.
 */
function loadFrame(html: string, scrollHeight?: () => number) {
  const doc = frame().contentDocument!;
  doc.body.innerHTML = html;
  if (scrollHeight)
    Object.defineProperty(doc.documentElement, "scrollHeight", {
      configurable: true,
      get: scrollHeight,
    });
  act(() => {
    doc.body.dispatchEvent(new doc.defaultView!.Event("load"));
  });
  return doc;
}

const csp = () =>
  frame()
    .contentDocument!.querySelector('meta[http-equiv="Content-Security-Policy"]')
    ?.getAttribute("content");

function click(doc: Document, selector: string) {
  const target = doc.querySelector(selector)!;
  const event = new doc.defaultView!.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
  });
  target.dispatchEvent(event);
  return event;
}

test("renders plain-text bodies linkified in the main document", () => {
  render(
    <EmailBody
      message={message({ bodyHtml: null, bodyText: "See https://example.com/a <b>now</b>" })}
    />,
  );
  expect(screen.queryByTitle("Message body")).toBeNull();
  const text = document.querySelector(".message-card__text.selectable")!;
  expect(text.textContent).toBe("See https://example.com/a <b>now</b>");
  expect(screen.getByRole("button", { name: "https://example.com/a" })).toBeInTheDocument();
});

test("uses sandbox allow-same-origin only", () => {
  render(<EmailBody message={message()} />);
  const iframe = frame();
  expect(iframe.getAttribute("sandbox")).toBe("allow-same-origin");
  expect(iframe.contentDocument!.body.innerHTML).toBe("<p>Hello <b>there</b></p>");
  expect(csp()).toContain("default-src 'none'");
});

test("writes the body into the frame before the browser paints, not a load later", () => {
  // A srcdoc loads a task after mount, so the frame painted at zero height first: switching threads
  // flashed the reply bar up under the header before the body popped in.
  render(<EmailBody message={message()} />);
  const iframe = frame();
  expect(iframe.hasAttribute("srcdoc")).toBe(false);
  expect(iframe.contentDocument!.body.innerHTML).toBe("<p>Hello <b>there</b></p>");
  // Already followed (and so measured), with no load event.
  const root = iframe.contentDocument!.documentElement;
  expect(FakeResizeObserver.instances.some((o) => o.targets.has(root))).toBe(true);

  // A later `load` for the same document leaves it alone.
  const doc = iframe.contentDocument!;
  doc.body.insertAdjacentHTML("beforeend", "<p id='kept'></p>");
  fireEvent.load(iframe);
  expect(doc.querySelector("#kept")).not.toBeNull();
});

test("a frame that comes back with a blank document is written again", () => {
  render(<EmailBody message={message()} />);
  const iframe = frame();
  const wrapper = iframe.parentElement!;
  // Re-inserting an iframe gives it a fresh about:blank, as React moving it would.
  iframe.remove();
  wrapper.append(iframe);
  fireEvent.load(iframe);
  expect(iframe.contentDocument!.body.innerHTML).toBe("<p>Hello <b>there</b></p>");
});

test("opening an HTML email loads remote images without another click", () => {
  render(
    <EmailBody
      message={message({
        bodyHtml: '<img src="https://example.com/photo.png">',
        hasRemoteContent: true,
      })}
    />,
  );
  expect(csp()).toContain("img-src data: pheeme-att: http://pheeme-att.localhost https: http:");
  expect(screen.queryByRole("button", { name: "Load images" })).toBeNull();
  expect(frame().getAttribute("sandbox")).toBe("allow-same-origin");
  expect(frame().getAttribute("referrerpolicy")).toBe("no-referrer");
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
  const aux = new doc.defaultView!.MouseEvent("auxclick", {
    bubbles: true,
    cancelable: true,
    button: 1,
  });
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
  const observer = FakeResizeObserver.instances.find((o) =>
    o.targets.has(frame().contentDocument!.documentElement),
  );
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

/** The frame scrolls whatever the email's own CSS says: inline `overflow: auto !important` on root and body. */
function expectScrollable(doc: Document) {
  for (const el of [doc.documentElement, doc.body]) {
    expect(el.style.getPropertyValue("overflow")).toBe("auto");
    expect(el.style.getPropertyPriority("overflow")).toBe("important");
  }
}

test("a pinned frame scrolls even when the email hides overflow", () => {
  render(<EmailBody message={message()} />);
  const doc = loadFrame(
    "<style>html,body{overflow:hidden !important}</style><div style='height:200vh'></div><p>Footer</p>",
    () => 2 * frameHeight() + 40,
  );
  // Not pinned yet: the email's own overflow is left alone.
  expect(doc.documentElement.style.getPropertyValue("overflow")).toBe("");
  for (let i = 0; i < 50; i++) FakeResizeObserver.fireAll();
  expectScrollable(doc);
  // The inline rule wins over the email's stylesheet in the cascade.
  expect(doc.defaultView!.getComputedStyle(doc.documentElement).overflow).toBe("auto");
});

test("caps enormous bodies at MAX_FRAME_HEIGHT and lets them scroll", () => {
  render(<EmailBody message={message()} />);
  const doc = loadFrame("<div style='height:90000px'></div>", () =>
    Math.max(90_000, frameHeight()),
  );
  expect(frameHeight()).toBe(MAX_FRAME_HEIGHT);
  expectScrollable(doc);
  for (let i = 0; i < 5; i++) FakeResizeObserver.fireAll();
  expect(frameHeight()).toBe(MAX_FRAME_HEIGHT);
});

test("a body that fits gets no forced scrolling", () => {
  render(<EmailBody message={message()} />);
  const doc = loadFrame("<div style='height:8000px'></div>", () => Math.max(8_000, frameHeight()));
  for (let i = 0; i < 5; i++) FakeResizeObserver.fireAll();
  expect(doc.documentElement.style.getPropertyValue("overflow")).toBe("");
  expect(doc.body.style.getPropertyValue("overflow")).toBe("");
});

/** A keydown as the frame's document would deliver it. */
function press(doc: Document, target: Element, key: string, init: KeyboardEventInit = {}) {
  const event = new doc.defaultView!.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
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
    const doc = loadFrame(
      '<p id="text">Some text</p><a id="web" href="https://example.com/">go</a>',
    );

    expect(press(doc, doc.querySelector("#text")!, "j").defaultPrevented).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);

    // Copy isn't a command, so it stays native (not prevented).
    expect(press(doc, doc.querySelector("#text")!, "c", { ctrlKey: true }).defaultPrevented).toBe(
      false,
    );
    expect(press(doc, doc.querySelector("#text")!, "c", { metaKey: true }).defaultPrevented).toBe(
      false,
    );
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

const frameStyles = () =>
  Array.from(frame().contentDocument!.querySelectorAll("style"), (el) => el.textContent).join("\n");

test("theme changes rewrite the frame document", () => {
  render(<EmailBody message={message()} />);
  expect(frameStyles()).not.toContain("invert(");
  act(() => useThemeStore.setState({ resolved: "dark" }));
  expect(frameStyles()).toContain("invert(1) hue-rotate(180deg)");
  expect(frame().contentDocument!.body.innerHTML).toBe("<p>Hello <b>there</b></p>");
});

test("lets go of the old frame document when it is rewritten or the body unmounts", async () => {
  const { unmount } = render(<EmailBody message={message()} />);
  loadFrame('<a id="web" href="https://example.com/">go</a>');
  // The rewrite keeps the same Document object, so a leaked listener would open the link twice.
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

test("a body that couldn't be fetched offers to try again instead of claiming the message is empty", () => {
  const retry = vi.fn();
  render(
    <EmailBody
      message={message({ bodyHtml: null, bodyText: null, bodyAvailable: false })}
      onRetry={retry}
    />,
  );
  expect(screen.queryByText("This message is empty.")).toBeNull();
  expect(screen.getByText("Couldn't load this message — you may be offline.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(retry).toHaveBeenCalledTimes(1);
});

test("a body that couldn't be fetched says why when the backend knows", () => {
  render(
    <EmailBody
      message={message({ bodyHtml: null, bodyText: null, bodyAvailable: false })}
      bodyError={{ code: "offline", message: "You're offline. Pheeme will try again." }}
      onRetry={() => {}}
    />,
  );
  expect(screen.getByText("You're offline. Pheeme will try again.")).toBeInTheDocument();
  expect(screen.queryByText("Couldn't load this message — you may be offline.")).toBeNull();
  expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
});

test("a body being fetched again shows what it's waiting on instead of the failure", () => {
  render(
    <EmailBody
      message={message({ bodyHtml: null, bodyText: null, bodyAvailable: false })}
      bodyError={{ code: "offline", message: "You're offline. Pheeme will try again." }}
      loading={{
        accountId: "a1",
        threadId: "t1",
        stage: "fetching",
        attempt: null,
        retryInMs: null,
        reason: null,
        syncBusy: false,
      }}
      onRetry={() => {}}
    />,
  );
  expect(screen.getByText("Downloading this message from Gmail…")).toBeInTheDocument();
  expect(screen.queryByText("You're offline. Pheeme will try again.")).toBeNull();
});

test("a fetched message with no body is empty", () => {
  render(<EmailBody message={message({ bodyHtml: null, bodyText: null })} />);
  expect(screen.getByText("This message is empty.")).toBeInTheDocument();
});

test("where the frame's listeners don't run (macOS WebKit), focus leaves the frame and mod+c copies its selection", () => {
  vi.useFakeTimers();
  try {
    render(
      <div tabIndex={-1} aria-label="Pane">
        <EmailBody message={message()} />
      </div>,
    );
    const pane = screen.getByLabelText("Pane");
    const doc = frame().contentDocument!;
    // Rewrite the frame with listeners on its document blocked, as WebKit does for a script-less sandbox.
    const dispatch = doc.dispatchEvent.bind(doc);
    doc.dispatchEvent = (e: Event) => (e.type === "pheeme-probe" ? true : dispatch(e));
    act(() => useThemeStore.setState({ resolved: "dark" }));

    // A click into the email focuses the frame; focus comes straight back so keys reach the app.
    frame().focus();
    expect(document.activeElement).toBe(frame());
    act(() => {
      window.dispatchEvent(new Event("blur"));
      vi.runAllTimers();
    });
    expect(pane).toHaveFocus();

    doc.execCommand = vi.fn(() => true);
    doc.getSelection()!.selectAllChildren(doc.body);
    const mod = platform === "macos" ? { metaKey: true } : { ctrlKey: true };
    expect(fireEvent.keyDown(pane, { key: "c", ...mod })).toBe(false);
    expect(doc.execCommand).toHaveBeenCalledWith("copy");
  } finally {
    vi.useRealTimers();
  }
});

/** Render in a pane with the frame's own listeners blocked (macOS WebKit), click into it, and select its text. */
function clickIntoBlockedFrame() {
  render(
    <div>
      <div tabIndex={-1} aria-label="Pane">
        <EmailBody message={message()} />
      </div>
      <button type="button">Elsewhere</button>
    </div>,
  );
  const doc = frame().contentDocument!;
  const dispatch = doc.dispatchEvent.bind(doc);
  doc.dispatchEvent = (e: Event) => (e.type === "pheeme-probe" ? true : dispatch(e));
  act(() => useThemeStore.setState({ resolved: "dark" }));
  frame().focus();
  act(() => {
    window.dispatchEvent(new Event("blur"));
    vi.runAllTimers();
  });
  doc.execCommand = vi.fn(() => true);
  doc.getSelection()!.selectAllChildren(doc.body);
  return { doc, pane: screen.getByLabelText("Pane") };
}

const COPY = { key: "c", ...(platform === "macos" ? { metaKey: true } : { ctrlKey: true }) };

test("mod+c still copies the email's selection when WebKit drops focus to the page during the drag", () => {
  vi.useFakeTimers();
  try {
    const { doc, pane } = clickIntoBlockedFrame();
    // Seen on macOS 27: drag-selecting in the frame leaves nothing focused in the app.
    act(() => pane.blur());
    expect(document.activeElement).toBe(document.body);

    expect(fireEvent.keyDown(document.body, COPY)).toBe(false);
    expect(doc.execCommand).toHaveBeenCalledWith("copy");
  } finally {
    vi.useRealTimers();
  }
});

test("after a click elsewhere in the app, mod+c no longer copies the email's old selection", () => {
  vi.useFakeTimers();
  try {
    const { doc } = clickIntoBlockedFrame();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    act(() => (document.activeElement as HTMLElement).blur());

    expect(fireEvent.keyDown(document.body, COPY)).toBe(true);
    expect(doc.execCommand).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("marks images that failed to load once the frame finishes loading", () => {
  render(<EmailBody message={message()} />);
  const doc = frame().contentDocument!;
  doc.body.innerHTML =
    '<img id="ok" alt="ok"><img id="failed" alt="Logo"><img id="pending" alt="p">';
  const state = (id: string, complete: boolean, naturalWidth: number) => {
    const image = doc.getElementById(id)!;
    Object.defineProperty(image, "complete", { configurable: true, value: complete });
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: naturalWidth });
  };
  state("ok", true, 520);
  state("failed", true, 0);
  state("pending", false, 0);

  // WebKit runs no listeners inside the script-less frame; the iframe's own `load` reaches the parent.
  fireEvent.load(frame());

  const broken = (id: string) => doc.getElementById(id)!.hasAttribute("data-pheeme-broken");
  expect(broken("ok")).toBe(false);
  expect(broken("failed")).toBe(true);
  expect(broken("pending")).toBe(false);
});
