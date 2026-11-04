/**
 * The document an HTML email body renders in (Builder's calls 11–13). The fragment arrives sanitized by
 * the backend, but ammonia can't filter CSS, so this shell's CSP blocks remote stylesheets and web fonts
 * and controls images (including CSS backgrounds). Open messages allow remote images; otherwise only
 * `data:` and the signed `pheeme-att` protocol can load images.
 */

export interface SrcdocOptions {
  /** Add `https: http:` to img-src for an opened message. */
  allowRemote: boolean;
  /** The app is showing its dark theme. */
  dark: boolean;
  /** The body has its own dark styles (`color-scheme` / `prefers-color-scheme: dark`). */
  declaresDark: boolean;
  /** The theme's text and link colors (CSS values), used where the email doesn't set its own. */
  textColor: string;
  linkColor: string;
}

const LOCAL_IMAGES = "img-src data: pheeme-att: http://pheeme-att.localhost";

/**
 * The brief's policy, plus `form-action` and `base-uri`, which don't fall back to `default-src`. Media,
 * frames, objects, connections and fonts from anywhere but `data:` stay blocked even with remote images on.
 */
export function contentSecurityPolicy(allowRemote: boolean): string {
  const images = allowRemote ? `${LOCAL_IMAGES} https: http:` : LOCAL_IMAGES;
  return `default-src 'none'; style-src 'unsafe-inline'; font-src data:; ${images}; form-action 'none'; base-uri 'none'`;
}

/** The bundled UI font can't load inside the frame (font-src is data: only), so bodies use the system's. */
const SYSTEM_FONTS =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const FLIP = "invert(1) hue-rotate(180deg)";
const MEDIA = 'img, video, picture, [style*="background-image"]';

/** Theme values are inserted into CSS, so accept only what a color can look like (no `;`, `{`, `<`, quotes). */
const SAFE_COLOR = /^[#\w\s(),.%/-]+$/;
const safeColor = (value: string) => {
  const v = value.trim();
  return v && SAFE_COLOR.test(v) ? v : null;
};

function themeCss({ dark, declaresDark, textColor, linkColor }: SrcdocOptions): string {
  if (dark && !declaresDark) {
    // A light email shown inverted: white base and black text become dark base and light text, hues kept;
    // media is flipped back (once: anything inside an already flipped element is left alone).
    return [
      `:root { color-scheme: light; }`,
      `html { background: white; color: black; filter: ${FLIP}; }`,
      `${MEDIA} { filter: ${FLIP}; }`,
      `:is(picture, [style*="background-image"]) :is(${MEDIA}) { filter: none; }`,
    ].join("\n");
  }
  const text = safeColor(textColor);
  const link = safeColor(linkColor);
  return [
    `:root { color-scheme: ${dark ? "light dark" : "light"}; }`,
    text ? `body { color: ${text}; }` : "",
    // Zero specificity, so any link color the email sets wins.
    link ? `:where(a) { color: ${link}; }` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const BASE_CSS = [
  // Height follows content (the frame is sized to it), never the frame's own viewport.
  `html, body { height: auto !important; min-height: 0 !important; }`,
  `body { margin: 0; overflow-wrap: anywhere; font: 14px/1.6 ${SYSTEM_FONTS}; }`,
  `img { max-width: 100%; height: auto; }`,
].join("\n");

/** Wrap a sanitized fragment in the frame's document. The fragment goes inside `<body>` verbatim. */
export function buildSrcdoc(html: string, opts: SrcdocOptions): string {
  return [
    "<!doctype html>",
    "<html><head>",
    `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(opts.allowRemote)}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta charset="utf-8">',
    `<style>\n${BASE_CSS}\n${themeCss(opts)}\n</style>`,
    `</head><body>${html}</body></html>`,
  ].join("\n");
}
