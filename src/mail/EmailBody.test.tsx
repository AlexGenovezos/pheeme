import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { MessageDetail } from "../lib/tauri";
import { useThemeStore } from "../theme/theme";
import { EmailBody } from "./EmailBody";

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

test("stops chasing content that grows with its own frame", () => {
  render(<EmailBody message={message()} />);
  // A 100vh element plus a footer: every resize makes the content taller by the same amount.
  loadFrame("<div style='height:100vh'></div><p>Footer</p>", () => (parseInt(frame().style.height, 10) || 300) + 40);
  const first = parseInt(frame().style.height, 10);
  for (let i = 0; i < 20; i++) FakeResizeObserver.fireAll();
  const settled = parseInt(frame().style.height, 10);
  expect(settled - first).toBeLessThanOrEqual(40 * 3);
  FakeResizeObserver.fireAll();
  expect(parseInt(frame().style.height, 10)).toBe(settled);
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

  unmount();
  expect(FakeResizeObserver.instances.every((o) => o.targets.size === 0)).toBe(true);
});
