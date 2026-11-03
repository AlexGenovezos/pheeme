import { platform } from "../lib/platform";
import { isTauri } from "../preview/runtime";

/** macOS desktop app: the title bar is hidden and the traffic lights float over our toolbars. */
export const overlayTitleBar = platform === "macos" && isTauri();

/** Spread onto toolbar elements so empty toolbar space drags the window (macOS overlay only). */
export const dragRegion: Record<string, string> = overlayTitleBar ? { "data-tauri-drag-region": "" } : {};
