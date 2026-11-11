import { afterEach, describe, expect, it } from "vitest";
import { findMatches, isStale, queryPattern } from "./findText";
import { throughFlip } from "./highlight";

const root = (html: string) => {
  const el = document.createElement("div");
  el.innerHTML = html;
  document.body.append(el);
  return el;
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("queryPattern", () => {
  it("is null for an empty query", () => {
    expect(queryPattern("   ")).toBeNull();
  });

  it("escapes regex characters and lets whitespace match any run", () => {
    const pattern = queryPattern(" a.b  (c) ")!;
    expect("A.B \n (C)".match(pattern)?.[0]).toBe("A.B \n (C)");
    expect("axb (c)".match(pattern)).toBeNull();
  });
});

describe("findMatches", () => {
  it("finds every match in order, case-insensitively", () => {
    const el = root("<p>Invoice due</p><p>The invoice is attached. INVOICE #4</p>");
    const { matches, capped } = findMatches(el, "invoice");
    expect(matches.map((r) => r.toString())).toEqual(["Invoice", "invoice", "INVOICE"]);
    expect(capped).toBe(false);
  });

  it("finds a word split across inline elements", () => {
    const el = root("<p>Your code is <b>48</b><i>12</i>.</p>");
    const [match] = findMatches(el, "4812").matches;
    expect(match.toString()).toBe("4812");
    expect(match.startContainer.textContent).toBe("48");
    expect(match.endContainer.textContent).toBe("12");
  });

  it("keeps words in separate blocks apart, but a spaced query spans them", () => {
    const el = root("<div>end</div><div>start</div>");
    expect(findMatches(el, "endstart").matches).toHaveLength(0);
    expect(findMatches(el, "end start").matches).toHaveLength(1);
  });

  it("treats <br> as a break", () => {
    const el = root("<p>one<br>two</p>");
    expect(findMatches(el, "onetwo").matches).toHaveLength(0);
    expect(findMatches(el, "one two").matches).toHaveLength(1);
  });

  it("skips text that never shows", () => {
    const el = root(
      '<style>.x { color: red }</style><p style="display:none">secret</p><p>visible secret</p>',
    );
    expect(findMatches(el, "secret").matches.map((r) => r.toString())).toEqual(["secret"]);
    expect(findMatches(el, "color").matches).toHaveLength(0);
  });

  it("reads an email frame's text where the frame sits", () => {
    const el = root("<p>before match</p><iframe></iframe><p>after match</p>");
    const doc = el.querySelector("iframe")!.contentDocument!;
    doc.open();
    doc.write("<!doctype html><html><body><p>inside match</p></body></html>");
    doc.close();
    const { matches } = findMatches(el, "match");
    expect(matches.map((r) => r.startContainer.textContent)).toEqual([
      "before match",
      "inside match",
      "after match",
    ]);
    expect(matches[1].startContainer.ownerDocument).toBe(doc);
  });

  it("stops at the cap", () => {
    const el = root("<p>a a a a a</p>");
    const { matches, capped } = findMatches(el, "a", 3);
    expect(matches).toHaveLength(3);
    expect(capped).toBe(true);
  });

  it("notices a match whose text was replaced", () => {
    const el = root("<p>hello</p>");
    const [match] = findMatches(el, "hello").matches;
    expect(isStale(match)).toBe(false);
    el.innerHTML = "<p>hello</p>";
    expect(isStale(match)).toBe(true);
  });
});

describe("throughFlip", () => {
  it("is its own inverse for colors the filter keeps in range", () => {
    expect(throughFlip("#000")).toBe("rgb(255, 255, 255)");
    expect(throughFlip("#ffffff")).toBe("rgb(0, 0, 0)");
  });

  it("leaves values it can't read alone", () => {
    expect(throughFlip("canvastext")).toBe("canvastext");
  });
});
