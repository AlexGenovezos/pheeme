// How guests answer an invitation, as the event popover and Mail's invite card both show it: the answers you can
// give, the word for each, and the tally of everyone else's.
import type { Attendee } from "../lib/tauri";

/** An answer you can give. */
export type Answer = "accepted" | "tentative" | "declined";

/** The buttons, in order. */
export const ANSWERS: { value: Answer; label: string }[] = [
  { value: "accepted", label: "Yes" },
  { value: "tentative", label: "Maybe" },
  { value: "declined", label: "No" },
];

/** A guest's answer as a word, for the icon's label (`needsAction` is no answer yet). */
export const answerWord: Record<string, string> = {
  accepted: "Yes",
  tentative: "Maybe",
  declined: "No",
  needsAction: "Awaiting",
};

const TALLY: { response: string; word: string }[] = [
  { response: "accepted", word: "yes" },
  { response: "tentative", word: "maybe" },
  { response: "declined", word: "no" },
  { response: "needsAction", word: "awaiting" },
];

/** "2 yes, 1 maybe, 1 awaiting": how many guests gave each answer, leaving out answers nobody gave. Empty with no guests. */
export function answerTally(guests: Attendee[]): string {
  return TALLY.map(({ response, word }) => ({
    word,
    n: guests.filter((g) => (g.response ?? "needsAction") === response).length,
  }))
    .filter(({ n }) => n > 0)
    .map(({ n, word }) => `${n} ${word}`)
    .join(", ");
}
