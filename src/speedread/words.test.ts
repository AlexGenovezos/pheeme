import { describe, expect, test } from "vitest";
import { beats, clampWpm, focusIndex, resumeIndex, timeLeft, toWords, wordDuration } from "./words";

const chars = (w: string) => Array.from(w);

describe("focusIndex", () => {
  test("pins short words near the start and long words further in", () => {
    expect(focusIndex(chars("a"))).toBe(0);
    expect(focusIndex(chars("at"))).toBe(1);
    expect(focusIndex(chars("pencil"))).toBe(2);
    expect(focusIndex(chars("unnecessary"))).toBe(3);
    expect(focusIndex(chars("accomplishments"))).toBe(4);
  });

  test("counts letters only, so quotes and punctuation don't shift it", () => {
    // “pencil,” → the focus is still the third letter, n.
    const word = chars("“pencil,”");
    expect(word[focusIndex(word)]).toBe("n");
  });

  test("keeps emoji whole and copes with words that have no letters", () => {
    expect(focusIndex(chars("—"))).toBe(0);
    expect(chars("👍🏽ok")).toHaveLength(4);
  });
});

describe("toWords", () => {
  test("marks sentence, clause and paragraph ends", () => {
    const words = toWords(["Hi there, Avery. Read “this.”", "Thanks"]);
    expect(words.map((w) => w.chars.join(""))).toEqual([
      "Hi",
      "there,",
      "Avery.",
      "Read",
      "“this.”",
      "Thanks",
    ]);
    expect(words[1]).toMatchObject({ clauseEnd: true, sentenceEnd: false });
    expect(words[2]).toMatchObject({ sentenceEnd: true, clauseEnd: false });
    expect(words[4]).toMatchObject({ sentenceEnd: true, paragraphEnd: true });
    expect(words[5].paragraphEnd).toBe(true);
    expect(words[3].paragraphEnd).toBe(false);
  });
});

describe("timing", () => {
  const [plain, comma, stop, end] = toWords(["word comma, stop. end"]);
  const [long] = toWords(["extraordinarily"]);

  test("adds a beat at sentence ends and half a beat at commas, only with pauses on", () => {
    expect(beats(plain, true)).toBe(1);
    expect(beats(comma, true)).toBe(1.5);
    expect(beats(stop, true)).toBe(2);
    expect(beats(end, true)).toBe(2.5);
    expect(beats(stop, false)).toBe(1);
  });

  test("holds long words a little longer", () => {
    expect(beats(long, false)).toBe(1.5);
  });

  test("turns beats into milliseconds at the chosen speed", () => {
    expect(wordDuration(plain, 300, true)).toBe(200);
    expect(wordDuration(stop, 300, true)).toBe(400);
    expect(timeLeft([plain, stop], 0, 300, true)).toBe(600);
    expect(timeLeft([plain, stop], 1, 300, false)).toBe(200);
  });

  test("keeps speeds on the slider's steps and range", () => {
    expect(clampWpm(20)).toBe(100);
    expect(clampWpm(5000)).toBe(1000);
    expect(clampWpm(312)).toBe(300);
  });
});

describe("resumeIndex", () => {
  test("backs up to the start of the sentence or paragraph", () => {
    const words = toWords(["One two. Three four five", "Six seven"]);
    expect(resumeIndex(words, 4)).toBe(2);
    expect(resumeIndex(words, 6)).toBe(5);
    expect(resumeIndex(words, 0)).toBe(0);
  });

  test("goes back no more than 20 words in a long sentence", () => {
    const words = toWords([Array.from({ length: 50 }, (_, i) => `w${i}`).join(" ")]);
    expect(resumeIndex(words, 45)).toBe(25);
  });
});
