const pixels = new Map<string, number>();

/** Reads fixed :root lengths. Themes change colors, and each list density has its own length token. */
export function staticPixelToken(token: string, fallback = 0): number {
  const cached = pixels.get(token);
  if (cached !== undefined) return cached;
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(token));
  if (!Number.isFinite(value) || value <= 0) return fallback;
  pixels.set(token, value);
  return value;
}
