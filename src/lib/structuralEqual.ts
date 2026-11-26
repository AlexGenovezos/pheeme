/**
 * Whether two plain values (strings, numbers, booleans, arrays, plain objects) hold the same
 * data. Compares in place, so it is cheap enough to run on every keystroke.
 */
export function structuralEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!structuralEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  for (const key in x) {
    if (!(key in y) || !structuralEqual(x[key], y[key])) return false;
  }
  for (const key in y) if (!(key in x)) return false;
  return true;
}
