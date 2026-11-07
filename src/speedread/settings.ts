import { create } from "zustand";
import { clampWpm } from "./words";

export const SPEED_READER_KEY = "pheeme.speed-reader";
export const WORD_SIZES = ["medium", "large"] as const;
export type WordSize = (typeof WORD_SIZES)[number];

export interface SpeedReaderPrefs {
  /** Show the Speed read button on emails that are simple prose. */
  offer: boolean;
  wpm: number;
  /** Linger at commas, sentence ends and paragraph breaks. */
  pauses: boolean;
  size: WordSize;
}

export const DEFAULT_PREFS: SpeedReaderPrefs = {
  offer: true,
  wpm: 300,
  pauses: true,
  size: "large",
};

function readPrefs(): SpeedReaderPrefs {
  try {
    const stored = JSON.parse(localStorage.getItem(SPEED_READER_KEY) ?? "{}") as Partial<
      Record<keyof SpeedReaderPrefs, unknown>
    >;
    return {
      offer: typeof stored.offer === "boolean" ? stored.offer : DEFAULT_PREFS.offer,
      wpm: typeof stored.wpm === "number" ? clampWpm(stored.wpm) : DEFAULT_PREFS.wpm,
      pauses: typeof stored.pauses === "boolean" ? stored.pauses : DEFAULT_PREFS.pauses,
      size: WORD_SIZES.includes(stored.size as WordSize)
        ? (stored.size as WordSize)
        : DEFAULT_PREFS.size,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

interface SpeedReaderSettings extends SpeedReaderPrefs {
  /** Change some settings; the reader and Settings both write through here, so they always agree. */
  update(change: Partial<SpeedReaderPrefs>): void;
}

export const useSpeedReaderSettings = create<SpeedReaderSettings>((set, get) => ({
  ...readPrefs(),
  update(change) {
    const next: SpeedReaderPrefs = { ...pick(get()), ...change };
    next.wpm = clampWpm(next.wpm);
    try {
      localStorage.setItem(SPEED_READER_KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable: the choice still holds for this session.
    }
    set(next);
  },
}));

const pick = ({ offer, wpm, pauses, size }: SpeedReaderPrefs): SpeedReaderPrefs => ({
  offer,
  wpm,
  pauses,
  size,
});
