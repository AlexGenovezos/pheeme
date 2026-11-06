import { create } from "zustand";

export const READING_SIZES = ["standard", "large"] as const;
export type ReadingSize = (typeof READING_SIZES)[number];
export const READING_SIZE_KEY = "pheeme.reading-size";

function readSize(): ReadingSize {
  try {
    const stored = localStorage.getItem(READING_SIZE_KEY);
    return stored === "large" ? "large" : "standard";
  } catch {
    return "standard";
  }
}

interface ReadingSettings {
  size: ReadingSize;
  setSize(size: ReadingSize): void;
}

export const useReadingSettings = create<ReadingSettings>((set) => ({
  size: readSize(),
  setSize(size) {
    try {
      localStorage.setItem(READING_SIZE_KEY, size);
    } catch {
      // Keep the current session's choice when storage is unavailable.
    }
    document.documentElement.dataset.readingSize = size;
    set({ size });
  },
}));

/** Restore before the first app render; CSS owns the sizes for both reading and composing. */
export function initReadingSize() {
  const size = readSize();
  document.documentElement.dataset.readingSize = size;
  useReadingSettings.setState({ size });
}
