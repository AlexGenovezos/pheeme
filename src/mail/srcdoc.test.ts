import { describe, expect, test } from "vitest";
import tauriConf from "../../src-tauri/tauri.conf.json";
import { buildSrcdoc, type SrcdocOptions } from "./srcdoc";

const base: SrcdocOptions = {
  allowRemote: false,
  dark: false,
  declaresDark: false,
  textColor: "#1a1f1f",
  linkColor: "#0b7a70",
};

/** Parse the shell the way the iframe will. */
function parse(html: string, over: Partial<SrcdocOptions> = {}) {
  return new DOMParser().parseFromString(buildSrcdoc(html, { ...base, ...over }), "text/html");
}

const csp = (doc: Document) =>
  doc.head.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ??
  "";

/** `{ directive: [sources] }` from a CSP string. */
function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name, ...sources]) => [name, sources]),
  );
}

const shellCss = (doc: Document) =>
  [...doc.head.querySelectorAll("style")].map((s) => s.textContent).join("\n");

describe("buildSrcdoc", () => {
  test("blocks remote images by default", () => {
    const doc = parse("<p>Hi</p>");
    const policy = csp(doc);
    expect(
      policy.startsWith(
        "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data: pheeme-att: http://pheeme-att.localhost",
      ),
    ).toBe(true);
    const d = directives(policy);
    expect(d["default-src"]).toEqual(["'none'"]);
    expect(d["style-src"]).toEqual(["'unsafe-inline'"]);
    expect(d["font-src"]).toEqual(["data:"]);
    expect(d["img-src"]).toEqual(["data:", "pheeme-att:", "http://pheeme-att.localhost"]);
    expect(policy).not.toContain("https:");
    expect(d["form-action"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'none'"]);
    // The CSP and referrer policy come before anything the email supplies.
    expect(doc.head.firstElementChild?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(doc.head.querySelector('meta[name="referrer"]')?.getAttribute("content")).toBe(
      "no-referrer",
    );
  });

  test("allows remote images on request", () => {
    const policy = csp(parse("<p>Hi</p>", { allowRemote: true }));
    expect(
      policy.startsWith(
        "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data: pheeme-att: http://pheeme-att.localhost https: http:",
      ),
    ).toBe(true);
    const d = directives(policy);
    expect(d["img-src"]).toEqual([
      "data:",
      "pheeme-att:",
      "http://pheeme-att.localhost",
      "https:",
      "http:",
    ]);
    // Only images: fonts, styles and everything else stay local.
    expect(d["default-src"]).toEqual(["'none'"]);
    expect(d["font-src"]).toEqual(["data:"]);
    expect(d["style-src"]).toEqual(["'unsafe-inline'"]);
  });

  test("sets the base typography and keeps images inside the frame width", () => {
    const css = shellCss(parse("<p>Hi</p>"));
    expect(css).toMatch(/body\s*{[^}]*margin:\s*0/);
    expect(css).toMatch(/body\s*{[^}]*overflow-wrap:\s*break-word/);
    expect(css).toMatch(/body\s*{[^}]*font:\s*14px\/1\.6 system-ui/);
    expect(css).toMatch(/img\s*{[^}]*max-width:\s*100%[^}]*height:\s*auto/);
  });

  test("applies invert only for dark themes without a dark declaration", () => {
    // Light theme: no filter, the app's text and link colors.
    const light = shellCss(parse("<p>Hi</p>"));
    expect(light).not.toContain("invert(");
    expect(light).toContain("color-scheme: light;");
    expect(light).toContain("color: #1a1f1f");
    expect(light).toContain("color: #0b7a70");

    // Dark theme, body has no dark styles: invert the page on a white base, re-invert media.
    const inverted = shellCss(
      parse("<p>Hi</p>", { dark: true, textColor: "#e4e9e9", linkColor: "#66d0c6" }),
    );
    expect(inverted).toMatch(/html\s*{[^}]*filter:\s*invert\(1\) hue-rotate\(180deg\)/);
    expect(inverted).toMatch(/html\s*{[^}]*background:\s*white/);
    expect(inverted).toMatch(
      /img, video, picture, \[style\*="background-image"\]\s*{\s*filter:\s*invert\(1\) hue-rotate\(180deg\)/,
    );
    // Light text would turn dark under the filter, so the theme colors are not used here.
    expect(inverted).not.toContain("#e4e9e9");

    // Dark theme, body declares dark: no filter, let it pick its dark styles.
    const declared = shellCss(
      parse("<p>Hi</p>", {
        dark: true,
        declaresDark: true,
        textColor: "#e4e9e9",
        linkColor: "#66d0c6",
      }),
    );
    expect(declared).not.toContain("invert(");
    expect(declared).toContain("color-scheme: light dark;");
    expect(declared).toContain("color: #e4e9e9");

    // A light theme ignores the declaration: nothing to adapt to.
    expect(shellCss(parse("<p>Hi</p>", { declaresDark: true }))).not.toContain("invert(");
  });

  test("escapes nothing it shouldn't", () => {
    const fragment =
      '<table><tr><td style="color:#c00">A &amp; B &lt;tag&gt;</td></tr></table><style>.x{color:red}</style><img src="pheeme-att://localhost/a/m/c?t=1" alt="">';
    const out = buildSrcdoc(fragment, base);
    expect(out).toContain(`<body>${fragment}</body>`);
    const doc = parse(fragment);
    expect(doc.querySelector("td")?.textContent).toBe("A & B <tag>");
    expect(doc.querySelector("img")?.getAttribute("src")).toBe("pheeme-att://localhost/a/m/c?t=1");
  });

  test("drops theme colors that aren't plain color values", () => {
    const css = shellCss(
      parse("<p>Hi</p>", {
        textColor: "red}</style><style>body{background:url(https://x)}",
        linkColor: "",
      }),
    );
    expect(css).not.toContain("url(");
    expect(css).not.toContain("red}");
  });
});

// A srcdoc frame inherits the app's CSP. Left alone, Tauri adds a nonce to style-src for index.html's
// inline <style>, which voids 'unsafe-inline': every email then renders unstyled (black serif text on
// the dark theme, no inversion) because the frame's <style> and style="" are blocked.
test("the app CSP leaves style-src unmodified so the email frame's styles apply", () => {
  expect(tauriConf.app.security.dangerousDisableAssetCspModification).toContain("style-src");
  expect(tauriConf.app.security.csp["style-src"]).toContain("'unsafe-inline'");
});
