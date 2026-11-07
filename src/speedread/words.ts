/**
 * Turning paragraphs into the words the speed reader flashes, and how long each one stays up.
 *
 * The rules follow the usual RSVP conventions (as in OpenSpritz and similar readers), written fresh here:
 * each word lines up on one letter a little left of its middle, so the eye never moves, and pauses
 * stretch at punctuation and paragraph ends so sentences still feel like sentences.
 */

export interface Word {
  /** The word as written, punctuation included, split into characters (so emoji stay whole). */
  chars: string[];
  /** Index into `chars` of the letter the eye rests on. */
  focus: number;
  /** Ends a sentence (`.`, `!`, `?`, `…`). */
  sentenceEnd: boolean;
  /** Ends a clause (`,`, `;`, `:`, a dash). */
  clauseEnd: boolean;
  /** Last word of its paragraph. */
  paragraphEnd: boolean;
}

const LETTER = /[\p{L}\p{N}]/u;
// Closing quotes and brackets can follow the punctuation that matters: `end."` still ends a sentence.
const SENTENCE_END = /[.!?…]["'”’)\]]*$/u;
const CLAUSE_END = /([,;:]|[—–-]{1,2})["'”’)\]]*$/u;

/**
 * The letter to line up on. Short words pin near the start, longer ones a little further in; this is the
 * common length table for the "optimal recognition point", counted over letters only so quotes and
 * brackets don't shift it.
 */
export function focusIndex(chars: string[]): number {
  const first = chars.findIndex((c) => LETTER.test(c));
  if (first < 0) return 0;
  let last = chars.length - 1;
  while (last > first && !LETTER.test(chars[last])) last--;
  const length = last - first + 1;
  const offset = length <= 1 ? 0 : length <= 5 ? 1 : length <= 9 ? 2 : length <= 13 ? 3 : 4;
  return first + offset;
}

export function toWords(paragraphs: string[]): Word[] {
  const words: Word[] = [];
  for (const paragraph of paragraphs) {
    const tokens = paragraph.split(/\s+/).filter(Boolean);
    tokens.forEach((token, i) => {
      const chars = Array.from(token);
      const sentenceEnd = SENTENCE_END.test(token);
      words.push({
        chars,
        focus: focusIndex(chars),
        sentenceEnd,
        clauseEnd: !sentenceEnd && CLAUSE_END.test(token),
        paragraphEnd: i === tokens.length - 1,
      });
    });
  }
  return words;
}

export const MIN_WPM = 100;
export const MAX_WPM = 1000;
export const WPM_STEP = 25;

export const clampWpm = (wpm: number) =>
  Math.min(MAX_WPM, Math.max(MIN_WPM, Math.round(wpm / WPM_STEP) * WPM_STEP));

/**
 * How many beats (one beat = one word at the chosen speed) a word stays up. Long words get a little
 * longer to read; with `pauses` on, commas get half a beat extra, sentence ends a full one, and a new
 * paragraph a beat and a half.
 */
export function beats(word: Word, pauses: boolean): number {
  const letters = word.chars.filter((c) => LETTER.test(c)).length;
  let total = letters > 12 ? 1.5 : letters > 8 ? 1.25 : 1;
  if (pauses) {
    if (word.paragraphEnd) total += 1.5;
    else if (word.sentenceEnd) total += 1;
    else if (word.clauseEnd) total += 0.5;
  }
  return total;
}

/** Milliseconds `word` stays on screen. */
export const wordDuration = (word: Word, wpm: number, pauses: boolean) =>
  (60_000 / wpm) * beats(word, pauses);

/** Milliseconds to read from `from` to the end. */
export function timeLeft(words: Word[], from: number, wpm: number, pauses: boolean): number {
  let ms = 0;
  for (let i = from; i < words.length; i++) ms += wordDuration(words[i], wpm, pauses);
  return ms;
}

/** Furthest a resumed reading backs up to find the start of its sentence. */
const MAX_REWIND = 20;

/**
 * Where to pick up a reading that stopped at `index`: the start of that sentence (or paragraph), so the
 * first words make sense again, but never more than a few lines back.
 */
export function resumeIndex(words: Word[], index: number): number {
  let i = index;
  while (i > 0 && index - i < MAX_REWIND) {
    const before = words[i - 1];
    if (before.sentenceEnd || before.paragraphEnd) break;
    i--;
  }
  return i;
}
