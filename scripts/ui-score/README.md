# UI scorecard

A measured score (0–100) for each part of the UI, from the real DOM of the browser preview.
Target: every part at 90 or above.

```bash
npm run dev                      # the preview on :1420
npm run ui:score -- --shots      # scores to scripts/ui-score/out/, screenshots with --shots
npm run ui:score -- --only week,event-editor
```

`run.mjs` opens each part (`PARTS`) in headless Chromium at a 1280×800 window, at the default
sidebar (220 px) and the narrowest the app allows, in light and dark: four variants. A part's score
is its worst variant. The macOS title bar is simulated: `data-overlay-titlebar` is set and the
traffic lights are drawn where macOS 26+ puts them (x 16–76, 14 px, measured from a Retina
screenshot). `score.js` runs in the page and does the measuring.

## How a part is scored

Seven criteria, 0–10 each. The base is their average × 10.

| Criterion | Measured | Score |
|---|---|---|
| Clipped text | Share of text shown in full (not cut off or ellipsized) | 10 × share |
| Contrast | Share of text at 4.5:1 against what is really behind it (3:1 for large text), opacity included | 10 × share (WCAG 2.2 1.4.3) |
| Type scale | Share of text on the 8 font-size tokens | 10 × share, −1 per size beyond 4 |
| Control heights | Labelled buttons, inputs and dropdowns at 24, 28 or 32 px | 10 × share (`--control-height-*`) |
| Border styles | Distinct border styles (width, style, colour) | 10 − 1 per style beyond 3 |
| Hit targets | Clickable things at least 24 × 24 px | 10 × share (WCAG 2.5.8) |
| Native controls | Browser date/time pickers and unstyled dropdowns, which look different on every OS | 10 − 2 each |

Then **15 points come off for each hard defect**:

- **Overlap**: two pieces of text, or two clickable things, on top of each other (as each
  shows, cut to its scroll and overflow boxes). A run of overlapping things counts once.
- **Wrap**: a short label (24 characters or fewer) that breaks onto a second line.
- **Cut**: a label cut down to fewer than 3 readable characters.
- **Window controls**: a control within 12 px of the macOS traffic lights.

Spacing, radii and colours are held to the tokens by `npm run lint:tokens`, so `score.js` only
reports them (`gate`).
