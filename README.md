<img src="public/brand/pheeme-mark-color.svg" width="64" height="64" alt="">

# pheeme.app

Marketing site for [pheeme](https://github.com/AlexGenovezos/pheeme), the open-source email client for developers.

Plain HTML and CSS, no build step. Everything in `public/` is served as-is by a Cloudflare Worker (static assets) at **pheeme.app** and **www.pheeme.app**.

## Deploys

- Push to `main` → GitHub Actions runs `wrangler deploy` → live on pheeme.app.
- Open a pull request → a preview version is uploaded (production is untouched).
- Needs the repo secret `CLOUDFLARE_API_TOKEN` (Cloudflare token from the "Edit Cloudflare Workers" template, scoped to the pheeme.app account and zone).

Manual deploy: `wrangler deploy`.

## Local preview

```sh
wrangler dev          # or: python3 -m http.server -d public 8787
```

## Layout

| Path | What |
| --- | --- |
| `public/index.html`, `styles.css`, `demo.js` | Home page and the keyboard inbox demo |
| `public/logos.html` | Logo download page (pheeme.app/logos) |
| `public/brand/` | Generated logo set: SVG + PNG, plus `pheeme-brand.zip` |
| `public/art/` | Halftone Pheme statue art (built by `scripts/build-fama.sh`) |
| `brand-src/` | Logo sources: outlined wordmark, social card template, statue source photo |
| `scripts/build-brand.mjs` | Regenerates `public/brand`, favicons, app icons and `og.png` |

## Logos

Edit the geometry or colors at the top of `scripts/build-brand.mjs`, then run:

```sh
node scripts/build-brand.mjs
```

It needs `magick` (ImageMagick), `zip`, and a Playwright `chrome-headless-shell` (or set `CHROME=/path/to/chrome`). The wordmark is Poppins SemiBold outlined to a path by `scripts/wordmark.py`, so it doesn't depend on the font. Site type is Instrument Sans and Martian Mono (both SIL OFL), self-hosted in `public/fonts`.

## Statue art and license

The hero statue is Fama (the Roman name for Pheme) by Robert Henze, on the Dresden Academy of Fine Arts. The source photo is [Dresden Fama (2005).jpg](https://commons.wikimedia.org/wiki/File:Dresden_Fama_(2005).jpg) by Brunswyk, licensed [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). `scripts/build-fama.sh` cuts it out, halftones and recolors it. The edited images in `public/art/` and the statue in `public/og.png` are shared under CC BY-SA 3.0 as well, and the site footer carries the credit. Keep the statue out of the logo, since that would put the logo under the same license.
