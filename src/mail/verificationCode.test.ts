import { describe, expect, it } from "vitest";
import type { MessageDetail } from "../lib/tauri";
import {
  conversationCode,
  findCode,
  htmlText,
  LIST_CODE_MAX_AGE,
  rowCode,
} from "./verificationCode";

describe("findCode", () => {
  it.each([
    ["Enter this temporary verification code to continue: 779693 Didn't request a code?", "779693"],
    ["Your verification code is 482913.", "482913"],
    ["482913 is your Instagram code. Don't share it.", "482913"],
    ["Use 4821 as your login code", "4821"],
    ["Your Microsoft account security code: 7302", "7302"],
    ["Your one-time passcode is 12345678", "12345678"],
    ["Your sign-in code: 779 693", "779693"],
    ["Your 2FA code is 123-456", "123456"],
    ["Here's your Slack verification code: ABC-D3F", "ABC-D3F"],
    ["Your login code is K7Q2XP", "K7Q2XP"],
    ["Your confirmation code is 551204", "551204"],
    ["Your OTP: 908172", "908172"],
    ["Your code is 3391", "3391"],
  ])("finds the code in %j", (text, code) => {
    expect(findCode(text)).toBe(code);
  });

  it.each([
    // No code wording at all.
    "Order #123456 has shipped. Track it with UPS.",
    "Call us on 0800 123 4567 between 9 and 5.",
    "Your invoice INV-2026 for $1,250.00 is attached.",
    // A promo code is not a sign-in code.
    "Use code SAVE20 for 20% off this weekend.",
    "Your discount code WINTER25 expires soon.",
    // Booking references are letters, and "confirmation" only vouches for digits.
    "Your flight confirmation code is QX7RTB.",
    // The wording is there but no code is near it.
    "We sent you a verification code. Check your phone.",
    // Years and prices aren't codes.
    "Your verification code expires in 2026.",
    "Security code changes cost $4500 per year.",
    // Digits inside a longer number.
    "Your verification code was sent to +1 555 0123 4567 8901.",
    "",
  ])("finds nothing in %j", (text) => {
    expect(findCode(text)).toBeNull();
  });

  it("prefers the code nearest the wording", () => {
    expect(
      findCode("Ref 2024-11. Your verification code is 660021. Account 99887766 was used."),
    ).toBe("660021");
  });

  it("takes the code next to the verification wording, not a promo code next to another 'code'", () => {
    expect(findCode("Your verification code is 123456. Discount code SAVE20")).toBe("123456");
  });

  it("doesn't take the end of a phone number for the code", () => {
    expect(findCode("Your verification code was sent to the phone ending in 1234.")).toBeNull();
    expect(
      findCode("Your verification code was sent to the phone ending in 1234. Your code is 908172"),
    ).toBe("908172");
  });

  it("reads codes that come before the wording in a subject", () => {
    expect(findCode("123456 is your Facebook confirmation code")).toBe("123456");
  });
});

describe("htmlText", () => {
  it("keeps a code split into one cell per digit together, and separates blocks", () => {
    const html =
      "<p>Enter this code:</p><table><tr><td>7</td><td>7</td><td>9</td><td>6</td><td>9</td><td>3</td></tr></table><p>Thanks</p>";
    expect(findCode(htmlText(html))).toBe("779693");
    expect(htmlText(html)).toMatch(/code:\s+779693\s+Thanks/);
  });

  it("skips styles and scripts", () => {
    expect(htmlText("<style>.a{width:123456px}</style><p>Hi</p>").trim()).toBe("Hi");
  });
});

const msg = (id: string, over: Partial<MessageDetail> = {}): MessageDetail => ({
  id,
  threadId: "t1",
  fromName: null,
  fromAddress: null,
  to: [],
  cc: [],
  subject: null,
  snippet: null,
  date: 0,
  bodyHtml: null,
  hasRemoteContent: false,
  declaresDarkMode: false,
  bodyText: null,
  bodyAvailable: true,
  unread: false,
  starred: false,
  labelIds: ["INBOX"],
  hasAttachment: false,
  attachments: [],
  ...over,
});

describe("conversationCode", () => {
  it("takes the newest message's code, skipping drafts", () => {
    const messages = [
      msg("m1", { snippet: "Your verification code is 111111" }),
      msg("m2", { snippet: "Your verification code is 222222" }),
      msg("m3", { snippet: "Your verification code is 333333", labelIds: ["DRAFT"] }),
      msg("m4", { snippet: "Thanks, that worked." }),
    ];
    expect(conversationCode(messages)).toEqual({ code: "222222", messageId: "m2" });
  });

  it("reads the body when the snippet stops short of the code", () => {
    const html = `<p>Hello! Here is the verification code you asked for:</p><table><tr>${[..."5150"]
      .map((d) => `<td>${d}</td>`)
      .join("")}</tr></table>`;
    expect(
      conversationCode([msg("m1", { snippet: "Hello! Here is the", bodyHtml: html })]),
    ).toEqual({ code: "5150", messageId: "m1" });
  });
});

describe("rowCode", () => {
  const now = 1_800_000_000_000;
  const row = { subject: "Your login code", snippet: "Your login code is 424242", date: now };

  it("offers the code while the email is under an hour old", () => {
    expect(rowCode(row, now + 5 * 60_000)).toBe("424242");
    expect(rowCode(row, now + LIST_CODE_MAX_AGE)).toBe("424242");
  });

  it("stops once it's older, or when the date is unknown", () => {
    expect(rowCode(row, now + LIST_CODE_MAX_AGE + 1)).toBeNull();
    expect(rowCode({ ...row, date: 0 }, now)).toBeNull();
  });
});
