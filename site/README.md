<img src="public/brand/pheeme-mark-color.svg" width="64" height="64" alt="">

# pheeme.app

Marketing site for pheeme, the open-source email client for developers. It lives in `site/` of the app repo; run the commands below from this folder.

Plain HTML and CSS, no build step. Everything in `public/` is served as-is by a Cloudflare Worker (static assets) at **pheeme.app** and **www.pheeme.app**.

## Deploys

`.github/workflows/site.yml` runs only when something under `site/` (or the workflow itself) changes.

- Push to `main` → GitHub Actions runs `wrangler deploy` → live on pheeme.app.
- Open a pull request → a preview version is uploaded (production is untouched).
- Needs the repo secret `CLOUDFLARE_API_TOKEN` (Cloudflare token from the "Edit Cloudflare Workers" template, scoped to the pheeme.app account and zone).

Manual deploy: `wrangler deploy`.

## Motion

`motion.js` drives everything that moves on scroll. A scene is a tall `<section data-scene="…">` whose `.sticky` child pins to the viewport. Each frame, the script turns scroll position into 0–1 progress and writes custom properties (`--e`, `--p`, `--z`, `--o`), and the CSS uses those values for its transforms. Elements with `data-reveal` fade up the first time they scroll into view. All of this switches on only through the `motion` class on `<html>`. Without JavaScript, or with reduced motion turned on, every scene shows as a normal section in its final state.

`node scripts/shoot.mjs <url> <prefix> <w> <h> <y1,y2,…>` screenshots a page at several scroll positions, which is handy for checking scenes.

## Local preview

```sh
wrangler dev          # or: python3 -m http.server -d public 8787
```

## Layout

| Path | What |
| --- | --- |
| `public/index.html`, `styles.css` | Home page (the stamp hero is an inline SVG symbol) |
| `public/motion.js` | Scroll scenes and reveal-on-enter animations |
| `public/demo.js` | The keyboard inbox demo |
| `public/logos.html` | Logo download page (pheeme.app/logos) |
| `public/brand/` | Generated logo set: SVG + PNG, plus `pheeme-brand.zip` |
| `public/art/` | Line-engraved Pheme statue for the stamp (built by `scripts/build-fama.sh`) |
| `brand-src/` | Logo sources: outlined wordmark, social card template, statue source photo |
| `scripts/build-brand.mjs` | Regenerates `public/brand`, favicons, app icons and `og.png` |

## Logos

Edit the geometry or colors at the top of `scripts/build-brand.mjs`, then run:

```sh
node scripts/build-brand.mjs
```

It also writes the desktop app's icon source (`../src-tauri/app-icon.svg`), favicon and mark (`../public/`). After changing the logo, run `npm run icons` from the repo root to regenerate the app's platform icons.

It needs `magick` (ImageMagick), `zip`, and a Playwright `chrome-headless-shell` (or set `CHROME=/path/to/chrome`). The wordmark is Poppins SemiBold outlined to a path by `scripts/wordmark.py`, so it doesn't depend on the font. Site type is Instrument Sans and Martian Mono (both SIL OFL), self-hosted in `public/fonts`.

## Statue art and license

The hero statue is Fama (the Roman name for Pheme) by Robert Henze, on the Dresden Academy of Fine Arts. The source photo is [Dresden Fama (2005).jpg](https://commons.wikimedia.org/wiki/File:Dresden_Fama_(2005).jpg) by Brunswyk, licensed [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). `scripts/build-fama.sh` cuts it out and redraws it as a line engraving. The edited images in `public/art/` and the stamp in `public/og.png` are shared under CC BY-SA 3.0 as well, and the site footer carries the credit. Keep the statue out of the logo, since that would put the logo under the same license.
