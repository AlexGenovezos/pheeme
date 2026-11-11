import { describe, expect, it } from "vitest";
import { baseSubject, similarSender, similarQuery } from "./similar";

describe("baseSubject", () => {
  it("drops reply and forward prefixes, however many", () => {
    expect(baseSubject("Re: Fwd: RE[2]: Lunch")).toBe("Lunch");
    expect(baseSubject("fw: Lunch ")).toBe("Lunch");
    expect(baseSubject("Reminder - I need your survey")).toBe("Reminder - I need your survey");
  });
});

describe("similarQuery", () => {
  it("searches the sender's address", () => {
    expect(similarQuery("sender", { sender: "surveys@caresense.com", subject: null })).toBe(
      "from:surveys@caresense.com",
    );
    expect(similarQuery("sender", { sender: null, subject: "x" })).toBeNull();
  });

  it("searches the subject as one phrase, without prefixes or quotes", () => {
    expect(
      similarQuery("subject", {
        sender: null,
        subject: 'Re: Dr. Papaliodis | Reminder - I need your "3 Months" survey',
      }),
    ).toBe('subject:"Dr. Papaliodis | Reminder - I need your 3 Months survey"');
    expect(similarQuery("subject", { sender: null, subject: " Re: " })).toBeNull();
    expect(similarQuery("subject", { sender: null, subject: null })).toBeNull();
  });
});

describe("similarSender", () => {
  const msg = (fromAddress: string, labelIds: string[] = []) => ({ fromAddress, labelIds });

  it("skips your own replies and drafts for the latest message from someone else", () => {
    expect(
      similarSender(
        { fromAddress: "me@x.com" },
        [msg("them@y.com"), msg("Me@X.com", ["SENT"]), msg("draft@z.com", ["DRAFT"])],
        "me@x.com",
      ),
    ).toBe("them@y.com");
  });

  it("falls back to the row's sender, unless that's you", () => {
    expect(similarSender({ fromAddress: "them@y.com" }, undefined, "me@x.com")).toBe("them@y.com");
    expect(similarSender({ fromAddress: "me@x.com" }, undefined, "me@x.com")).toBeNull();
    expect(similarSender(undefined, [msg("me@x.com")], "me@x.com")).toBeNull();
  });
});
