import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { linkify } from "./linkify";

test("linkify turns URLs into link buttons and leaves other text escaped", () => {
  const opened: string[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "open_mail_link") opened.push((args as { url: string }).url);
    return undefined;
  });
  const { container } = render(<p>{linkify("Read <b>this</b>: https://example.com/a?b=1, or (https://example.org/x). Then http://x.test.")}</p>);

  expect(container.querySelector("b")).toBeNull();
  expect(container.textContent).toBe("Read <b>this</b>: https://example.com/a?b=1, or (https://example.org/x). Then http://x.test.");
  const links = screen.getAllByRole("button");
  expect(links.map((l) => l.textContent)).toEqual(["https://example.com/a?b=1", "https://example.org/x", "http://x.test"]);

  fireEvent.click(links[1]);
  expect(opened).toEqual(["https://example.org/x"]);
});

test("linkify keeps a bracket the URL itself opened, and ignores other schemes", () => {
  render(<p>{linkify("https://en.wikipedia.org/wiki/Mail_(disambiguation) and javascript:alert(1) and mailto:a@b.c")}</p>);
  expect(screen.getAllByRole("button").map((l) => l.textContent)).toEqual(["https://en.wikipedia.org/wiki/Mail_(disambiguation)"]);
  vi.restoreAllMocks();
});
