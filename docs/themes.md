# Custom themes

Settings › Appearance › **Import a theme** installs one or more `.json` files. Each file is either a
VS Code color theme or a Pheeme theme file. Pheeme keeps the installed themes in the webview's local
storage (`pheeme.custom-themes`). **Light theme** and **Dark theme** choose which theme each mode
uses. To remove a custom theme, choose it and press the bin button next to it.

## VS Code themes

Use the theme's JSON file, the one listed under `contributes.themes` in a theme extension. Comments
and trailing commas are fine. Pheeme reads each color from the matching VS Code key (the table in
`src/styles/themes/schema.ts`). When a key is missing, Pheeme mixes the color from the theme's own
background and text, or takes it from Pheeme's built-in theme of the same kind (status, avatar and
mailbox colors). Translucent VS Code colors are flattened onto the surface they sit on. Last, every
color is adjusted until text meets WCAG AA on every surface Pheeme draws it on
(`src/styles/themes/contrast.ts`), so some colors can differ slightly from VS Code. `include` (a
parent theme file) isn't followed; missing colors are filled in as above.

## Pheeme theme files

```json
{
  "version": 1,
  "name": "Harbour Night",
  "kind": "dark",
  "colors": {
    "app-bg": "#10161c",
    "sidebar-bg": "#0c1116",
    "foreground": "#e2e8ee",
    "accent": "#5fb3d9"
  }
}
```

- `kind` is `light` or `dark`. It decides which mode the theme is offered for, and which built-in
  theme fills in the colors the file leaves out.
- `colors` keys are the theme token names without `--color-`, from `src/styles/themes/schema.ts`
  (`app-bg`, `accent`, `list-active-bg`, …). Values are any CSS color: hex, `rgb()`, `hsl()`,
  `oklch()`. Pheeme stores them as OKLCH. Unknown keys are ignored.
- Hover and other variant colors (`accent-hover`, `control-active-bg`, … — `DERIVED` in
  `src/styles/themes/build.ts`) are worked out from the file's own base colors. A file can set them
  to override that.
- `id` is optional. It defaults to the name in lowercase with hyphens. `system`, `light`, `dark`,
  `pheeme-light` and `pheeme-dark` are reserved. Importing a theme with an id that's already
  installed replaces it.
- Pheeme doesn't change a theme file's colors, so check contrast yourself.
