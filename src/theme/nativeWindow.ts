import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ThemeDefinition } from "../styles/themes";
import { themeColorToHex } from "../styles/themes/color";
import { platform } from "../lib/platform";
import { isTauri } from "../preview/runtime";
import { systemPrefersDark, type ThemeMode } from "./theme";

/** macOS app: the window is transparent over sidebar vibrancy (tauri.macos.conf.json). */
export const vibrancy = platform === "macos" && isTauri();

/**
 * Keep the native window in step with the app theme: title bar / traffic
 * lights (and the vibrancy material) follow the chosen mode, and the window
 * background matches so a resize never flashes the wrong color behind the webview.
 */
export function syncNativeWindow(mode: ThemeMode, theme: ThemeDefinition) {
  const win = getCurrentWindow();
  const warn = (what: string) => (err: unknown) => console.warn(`${what} failed`, err);
  // System mode lets the OS drive the title bar, unless the theme is the other kind
  // (a dark theme chosen for Light mode): then the title bar follows the theme.
  const followOs = mode === "system" && theme.kind === (systemPrefersDark() ? "dark" : "light");
  win.setTheme(followOs ? null : theme.kind).catch(warn("setTheme"));
  // A transparent window must stay transparent, or the vibrancy behind the sidebar is covered.
  if (!vibrancy)
    win
      .setBackgroundColor(themeColorToHex(theme.tokens["--color-app-bg"]))
      .catch(warn("setBackgroundColor"));
}

let revealed = false;

/**
 * The window starts hidden (`visible: false` in tauri.conf.json) so launch never shows the native background in the
 * wrong theme or an empty frame. Show it once the first real screen is rendered; the Rust side shows it anyway after
 * a timeout if this never runs.
 */
export function revealWindow() {
  if (revealed) return;
  revealed = true;
  // Called after React commits the first screen. Not via requestAnimationFrame: a hidden window may never get one.
  getCurrentWindow()
    .show()
    .catch((err: unknown) => console.warn("show failed", err));
}
