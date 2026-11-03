import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ThemeDefinition } from "../styles/themes";
import type { ThemeMode } from "./theme";

/**
 * Keep the native window in step with the app theme: title bar / traffic
 * lights follow the chosen mode, and the window background matches so a
 * resize never flashes the wrong color behind the webview.
 */
export function syncNativeWindow(mode: ThemeMode, theme: ThemeDefinition) {
  const win = getCurrentWindow();
  const warn = (what: string) => (err: unknown) => console.warn(`${what} failed`, err);
  win.setTheme(mode === "system" ? null : theme.kind).catch(warn("setTheme"));
  win.setBackgroundColor(theme.tokens["--color-app-bg"]).catch(warn("setBackgroundColor"));
}
