export type Platform = "macos" | "windows" | "linux";

interface NavigatorLike {
  userAgent: string;
  platform?: string;
  userAgentData?: { platform?: string };
}

/** Which OS the webview runs on. Used for window integration and shortcut labels only. */
export function detectPlatform(nav: NavigatorLike = navigator): Platform {
  const hint = `${nav.userAgentData?.platform ?? ""} ${nav.platform ?? ""} ${nav.userAgent}`;
  if (/mac|iphone|ipad/i.test(hint)) return "macos";
  if (/win/i.test(hint)) return "windows";
  return "linux";
}

export const platform: Platform =
  typeof navigator === "undefined" ? "linux" : detectPlatform(navigator as NavigatorLike);
