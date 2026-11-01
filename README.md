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
| `brand-src/` | Logo sources: outlined wordmark and the social card template |
| `scripts/build-brand.mjs` | Regenerates `public/brand`, favicons, app icons and `og.png` |

## Logos

Edit the geometry or colors at the top of `scripts/build-brand.mjs`, then run:

```sh
node scripts/build-brand.mjs
```

It needs `magick` (ImageMagick), `zip`, and a Playwright `chrome-headless-shell` (or set `CHROME=/path/to/chrome`). The wordmark is Poppins SemiBold outlined to a path by `scripts/wordmark.py`, so it doesn't depend on the font. Site type is Instrument Sans and Martian Mono (both SIL OFL), self-hosted in `public/fonts`.
