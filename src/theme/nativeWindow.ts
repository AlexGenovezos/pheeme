import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ThemeDefinition } from "../styles/themes";
import { platform } from "../lib/platform";
import { isTauri } from "../preview/runtime";
import type { ThemeMode } from "./theme";

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
  win.setTheme(mode === "system" ? null : theme.kind).catch(warn("setTheme"));
  // A transparent window must stay transparent, or the vibrancy behind the sidebar is covered.
  if (!vibrancy)
    win.setBackgroundColor(theme.tokens["--color-app-bg"]).catch(warn("setBackgroundColor"));
}

let revealed = false;

/**
 * The window starts hidden (`visible: false` in tauri.conf.json) so launch never shows the native background in the
 * wrong theme or an empty frame. Show it once the first real screen has painted; the Rust side shows it anyway after
 * a timeout if this never runs.
 */
export function revealWindow() {
  if (revealed) return;
  revealed = true;
  // Two frames: the first runs before paint, the second after it.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      getCurrentWindow()
        .show()
        .catch((err: unknown) => console.warn("show failed", err));
    }),
  );
}
