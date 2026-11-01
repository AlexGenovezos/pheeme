/**
 * Are we inside the Tauri webview, or a plain browser (browser preview mode)?
 *
 * Decided once at startup, before preview mode installs its IPC mock (which
 * itself defines `__TAURI_INTERNALS__` and would otherwise fool the check).
 */
export function detectTauri(win: object): boolean {
  return "__TAURI_INTERNALS__" in win;
}

const tauriAtStartup = typeof window !== "undefined" && detectTauri(window);

export const isTauri = (): boolean => tauriAtStartup;
export const isPreview = (): boolean => !tauriAtStartup;
