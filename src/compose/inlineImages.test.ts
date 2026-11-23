import { expect, test, vi } from "vitest";
import type { StagedAttachment } from "../lib/tauri";
import { emptyDraft, isBlank } from "./composeStore";
import {
  forgetImages,
  inlineImageUrl,
  isPastedImage,
  outgoingDraft,
  stagedImage,
  stagingImage,
  withoutImages,
} from "./inlineImages";

const att = (id: string, contentId: string | null): StagedAttachment => ({
  id,
  filename: `${id}.png`,
  mimeType: "image/png",
  size: 4,
  contentId,
});

test("a pasted image deleted from the text isn't sent; files and the quote's images are", () => {
  const draft = {
    ...emptyDraft(),
    bodyHtml: '<p>Hi <img src="cid:kept@pheeme.app"></p>',
    quoteHtml: '<div class="gmail_quote"><img src="cid:quoted@pheeme.app"></div>',
    attachments: [
      att("kept", "kept@pheeme.app"),
      att("deleted", "deleted@pheeme.app"),
      att("quoted", "quoted@pheeme.app"),
      att("logo", "logo@sender.example"),
      att("file", null),
    ],
  };
  expect(outgoingDraft(draft).attachments.map((a) => a.id)).toEqual([
    "kept",
    "quoted",
    "logo",
    "file",
  ]);
  const unchanged = { ...draft, attachments: [att("kept", "kept@pheeme.app")] };
  expect(outgoingDraft(unchanged)).toBe(unchanged);
});

test("only images this app pasted count as pasted", () => {
  expect(isPastedImage(att("a", "abc@pheeme.app"))).toBe(true);
  expect(isPastedImage(att("b", "logo@sender.example"))).toBe(false);
  expect(isPastedImage(att("c", null))).toBe(false);
});

test("a message that is only a pasted image isn't blank", () => {
  expect(isBlank({ ...emptyDraft(), bodyHtml: '<p><img src="cid:a@pheeme.app"></p>' })).toBe(false);
  expect(isBlank({ ...emptyDraft(), bodyHtml: "<p></p>" })).toBe(true);
  // Pasted, then deleted from the text: nothing is left to send.
  expect(
    isBlank({
      ...emptyDraft(),
      bodyHtml: "<p></p>",
      attachments: [att("gone", "gone@pheeme.app")],
    }),
  ).toBe(true);
});

test("a pasted image shows from its bytes while staged, then only in the panel that has its file", async () => {
  let n = 0;
  const revoked: string[] = [];
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: () => `blob:${++n}`,
      revokeObjectURL: (u: string) => revoked.push(u),
    }),
  );
  stagingImage("x1@pheeme.app", new Blob(["png"]));
  expect(await inlineImageUrl("x1@pheeme.app", [])).toBe("blob:1");
  const mine = att("s1", "x1@pheeme.app");
  stagedImage("x1@pheeme.app", mine);
  expect(await inlineImageUrl("x1@pheeme.app", [mine])).toBe("blob:1");
  // Copied into another panel, which has no file to send with it.
  expect(await inlineImageUrl("x1@pheeme.app", [])).toBeNull();
  // Another draft's file under the same Content-ID keeps its own image when this one closes.
  const theirs = att("s2", "x1@pheeme.app");
  stagedImage("x1@pheeme.app", null);
  forgetImages([theirs]);
  forgetImages([mine]);
  await Promise.resolve();
  expect(revoked).toEqual(["blob:1"]);

  // Staging failed: its bytes go.
  stagingImage("x2@pheeme.app", new Blob(["png"]));
  stagedImage("x2@pheeme.app", null);
  expect(revoked).toEqual(["blob:1", "blob:2"]);
  expect(await inlineImageUrl("x2@pheeme.app", [])).toBeNull();
  vi.unstubAllGlobals();
});

test("withoutImages takes out only the named images", () => {
  expect(
    withoutImages(
      '<p>a<img src="cid:A1@pheeme.app" alt="x" style="max-width:100%">b<img src="cid:b2@pheeme.app"></p>',
      ["a1@pheeme.app"],
    ),
  ).toBe('<p>ab<img src="cid:b2@pheeme.app"></p>');
});
