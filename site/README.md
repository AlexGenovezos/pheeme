<img src="public/brand/pheeme-mark-color.svg" width="64" height="64" alt="">

# pheeme.app

Marketing site for pheeme, the open-source email client for developers. It lives in `site/` of the app repo. Run npm commands from the repository root; other commands below run from `site/`.

The marketing pages are plain HTML and CSS. `npm run build:site` copies `site/public/` to `site/dist/` and builds the actual app into `site/dist/demo/`, using the same Vite configuration and entry point as the desktop client. A Cloudflare Worker serves those static assets at **pheeme.app** and **www.pheeme.app**.

The home page embeds `/demo/` in an iframe, keeping the app's styles and shortcuts isolated from the marketing page. The existing browser preview backend (`src/preview/install.ts`) supplies sample mail: the app's components, styles and interactions run unchanged, while Gmail and desktop services are simulated. Mail changes reset on reload; preferences such as theme and pane widths persist in the visitor's browser. On small screens the embed scrolls horizontally to preserve the desktop layout. The full demo is also available directly at `/demo/`.

## Deploys

`.github/workflows/site.yml` runs for every pull request and push to `main`, including app changes. It installs dependencies, builds the combined site, and runs browser checks before deploying. This keeps the website's demo in sync with the app source on `main`; there is no separate demo UI to maintain or generated bundle to commit.

- Push to `main` → build and browser checks → `wrangler deploy` → live on pheeme.app.
- Open a pull request → a preview version is uploaded (production is untouched).
- Needs the repo secret `CLOUDFLARE_API_TOKEN` (Cloudflare token from the "Edit Cloudflare Workers" template, scoped to the pheeme.app account and zone).

Manual deploy: run `npm run build:site` from the repository root, then `wrangler deploy` from `site/`.

## Motion

`motion.js` drives everything that moves on scroll. A scene is a tall `<section data-scene="…">` whose `.sticky` child pins to the viewport. Each frame, the script turns scroll position into 0–1 progress and writes custom properties (`--e`, `--p`, `--z`, `--o`), and the CSS uses those values for its transforms. Elements with `data-reveal` fade up the first time they scroll into view. All of this switches on only through the `motion` class on `<html>`. Without JavaScript, or with reduced motion turned on, every scene shows as a normal section in its final state.

`node scripts/shoot.mjs <url> <prefix> <w> <h> <y1,y2,…>` screenshots a page at several scroll positions, which is handy for checking scenes.

## Local preview

```sh
# From the repository root:
npm run build:site
cd site
wrangler dev          # or: python3 -m http.server -d dist 8787
```

Run `npm run test:site` from the repository root to build the site and check the embedded app, archive/search, lazy-loaded compose, settings, sample-mail reset, and narrow-screen scrolling in Chromium. Install the browser first with `npx playwright install chromium` if needed. The test server uses Python 3.

## Layout

| Path | What |
| --- | --- |
| `public/index.html`, `styles.css` | Home page (the stamp hero is an inline SVG symbol) |
| `public/motion.js` | Scroll scenes and reveal-on-enter animations |
| `scripts/build.mjs` | Builds the marketing pages and real app preview into `dist/` |
| `dist/demo/` | Generated app preview embedded by the home page (not committed) |
| `public/download.js` | Points the hero download button at the latest release installer for the visitor's OS |
| `public/changelog.html`, `changelog.js` | pheeme.app/changelog: every GitHub release with its notes, fetched live (notes come from `docs/releases/` in the app repo) |
| `public/logos.html` | Logo download page (pheeme.app/logos) |
| `public/brand/` | Generated logo set: SVG + PNG, plus `pheeme-brand.zip` |
| `public/art/` | Line-engraved Pheme statue for the stamp (built by `scripts/build-fama.sh`) |
| `brand-src/` | Logo sources: outlined wordmark, social card template, statue source photo |
| `scripts/build-brand.mjs` | Regenerates `public/brand`, favicons, web app icons and `og.png` |
| `scripts/build-fama-icon.sh` | Engraves the desktop app icon (`../src-tauri/app-icon.svg`) from `brand-src/fama-icon-source.jpg` |

## Logos

Edit the geometry or colors at the top of `scripts/build-brand.mjs`, then run:

```sh
node scripts/build-brand.mjs
```

The app and website favicons, touch icons, and downloadable app icons all use the statue engraving in `../src-tauri/app-icon.svg`. Browser icons crop away the desktop Dock padding. To change the engraving, run `scripts/build-fama-icon.sh` (ImageMagick and python3), then `npm run icons` from the repo root for desktop platform sizes and `node scripts/build-brand.mjs` from this directory for the web assets. The brand build also writes the app's favicon and color mark (`../public/`).

It needs `magick` (ImageMagick), `zip`, and a Playwright `chrome-headless-shell` (or set `CHROME=/path/to/chrome`). The wordmark is Poppins SemiBold outlined to a path by `scripts/wordmark.py`, so it doesn't depend on the font. Site type is Instrument Sans and Martian Mono (both SIL OFL), self-hosted in `public/fonts`.

## Statue art and license

The hero statue is Fama (the Roman name for Pheme) by Robert Henze, on the Dresden Academy of Fine Arts. The source photo is [Dresden Fama (2005).jpg](https://commons.wikimedia.org/wiki/File:Dresden_Fama_(2005).jpg) by Brunswyk, licensed [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). `scripts/build-fama.sh` cuts it out and redraws it as a line engraving. The edited images in `public/art/` and the stamp in `public/og.png` are shared under CC BY-SA 3.0 as well, and the site footer carries the credit. Keep this photo out of the logo and the app icon, since that would put them under the same license.

The desktop app icon uses a different photo of the same statue, [Gold (82911013).jpeg](https://commons.wikimedia.org/wiki/File:Gold_(82911013).jpeg) by Etrick, licensed [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) (credit only, no share-alike). `scripts/build-fama-icon.sh` crops it to the head and trumpet and engraves it as vector lines. The credit sits in the site footer and the repo README.
