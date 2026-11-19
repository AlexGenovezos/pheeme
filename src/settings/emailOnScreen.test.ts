import { expect, test } from "vitest";
import { imagesOnScreen } from "./emailOnScreen";

function body(messageId: string, held: boolean, images: string[]) {
  const root = document.createElement("div");
  root.className = "thread-view__retained";
  root.dataset.visible = "true";
  const el = document.createElement("div");
  el.className = "email-body";
  el.dataset.messageId = messageId;
  if (held) el.setAttribute("data-images-held", "");
  const frame = document.createElement("iframe");
  el.append(frame);
  root.append(el);
  document.body.append(root);
  frame.contentDocument!.body.innerHTML = images.map((src) => `<img src="${src}">`).join("");
}

test("a Spam message's held-back remote images stay out of the report, so the backend never fetches them", () => {
  body("spam", true, [
    "https://tracker.example/open.gif",
    "ht&#9;tps://tracker.example/tab.gif",
    " HTTP://tracker.example/upper.gif",
    "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
  ]);
  body("inbox", false, ["https://example.com/photo.png"]);
  expect(imagesOnScreen().map((i) => [i.messageId, i.src.slice(0, 30)])).toEqual([
    ["spam", "data:image/gif;base64,R0lGODlh"],
    ["inbox", "https://example.com/photo.png"],
  ]);
});
