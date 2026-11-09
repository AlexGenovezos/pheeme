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
  // System mode leaves the appearance to the OS. setTheme sets it app-wide, which is
  // what prefers-color-scheme reports, so overriding it here would re-resolve the
  // theme from the override and flip back and forth forever.
  win.setTheme(mode === "system" ? null : theme.kind).catch(warn("setTheme"));
  if (vibrancy) {
    // The vibrancy material has the window's appearance. Under a theme of the other
    // kind (a light theme in dark mode) it would show dark through a light sidebar,
    // so the sidebar and window go solid instead.
    const appearance = mode === "system" ? (systemPrefersDark() ? "dark" : "light") : theme.kind;
    if (theme.kind === appearance) document.documentElement.dataset.vibrancy = "";
    else delete document.documentElement.dataset.vibrancy;
  } else
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
