import { describe, expect, test } from "vitest";
import type { Attendee } from "../lib/tauri";
import { answerTally } from "./rsvp";

const guest = (response: string | null): Attendee => ({ response }) as Attendee;

describe("answerTally", () => {
  test("counts each answer in order, a missing one as awaiting, and skips answers nobody gave", () => {
    const guests = [
      guest("declined"),
      guest("accepted"),
      guest(null),
      guest("accepted"),
      guest("needsAction"),
    ];
    expect(answerTally(guests)).toBe("2 yes, 1 no, 2 awaiting");
  });

  test("is empty with no guests", () => {
    expect(answerTally([])).toBe("");
  });
});
