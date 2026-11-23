import { expect, test, vi } from "vitest";
import type { StagedAttachment } from "../lib/tauri";
import { emptyDraft, isBlank } from "./composeStore";
import { inlineImageUrl, isPastedImage, outgoingDraft, rememberImage } from "./inlineImages";

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

test("an image shows only in the panel that has its file, or that is still staging it", async () => {
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:shot" }));
  rememberImage("x1@pheeme.app", new Blob(["png"]));
  // Copied into another panel, which has no file to send with it.
  expect(await inlineImageUrl("x1@pheeme.app", [], false)).toBeNull();
  expect(await inlineImageUrl("x1@pheeme.app", [], true)).toBe("blob:shot");
  expect(await inlineImageUrl("x1@pheeme.app", [att("x1", "x1@pheeme.app")], false)).toBe(
    "blob:shot",
  );
  vi.unstubAllGlobals();
});
