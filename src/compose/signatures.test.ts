import { mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, expect, test } from "vitest";
import {
  __resetSignaturesForTests,
  bodyWithSignature,
  hasContent,
  useSignatures,
  withoutSignature,
} from "./signatures";

let fetches: string[];
let answer: (accountId: string) => unknown;

beforeEach(() => {
  localStorage.clear();
  __resetSignaturesForTests();
  fetches = [];
  answer = () => "<b>Me</b>";
  mockIPC((cmd, args) => {
    if (cmd !== "gmail_signature") return undefined;
    const accountId = String((args as { accountId: string }).accountId);
    fetches.push(accountId);
    return answer(accountId);
  });
});

const sig = () => useSignatures.getState();

test("new messages and replies use Gmail's signature until told otherwise", async () => {
  expect(sig().signatureFor("a1", "new")).toBeNull(); // not fetched yet
  await sig().refreshGmail("a1");
  expect(sig().signatureFor("a1", "new")).toBe("<b>Me</b>");
  expect(sig().signatureFor("a1", "reply")).toBe("<b>Me</b>");

  sig().update("a1", { custom: "<p>Cheers, Me</p>", replies: "custom", newMessages: "none" });
  expect(sig().signatureFor("a1", "new")).toBeNull();
  expect(sig().signatureFor("a1", "reply")).toBe("<p>Cheers, Me</p>");
  expect(sig().signatureFor("a2", "reply")).toBeNull(); // another account keeps its own choices
});

test("an empty own signature counts as none", () => {
  sig().update("a1", { custom: "<p></p>", newMessages: "custom" });
  expect(sig().signatureFor("a1", "new")).toBeNull();
  sig().update("a1", { custom: '<p><img src="https://x/logo.png"></p>' });
  expect(sig().signatureFor("a1", "new")).toContain("logo.png");
});

test("choices and the last Gmail signature survive a relaunch", async () => {
  await sig().refreshGmail("a1");
  sig().update("a1", { replies: "none" });
  useSignatures.setState({ settings: {}, gmail: {} });
  __resetSignaturesForTests();
  expect(sig().forAccount("a1").replies).toBe("none");
  expect(sig().gmail.a1).toEqual({ html: "<b>Me</b>", loading: false });
});

test("a failed fetch keeps the signature it already had", async () => {
  await sig().refreshGmail("a1");
  answer = () => {
    throw { code: "missing_scope", message: "Insufficient Permission" };
  };
  await sig().refreshGmail("a1");
  expect(sig().gmail.a1.error?.code).toBe("missing_scope");
  expect(sig().signatureFor("a1", "new")).toBe("<b>Me</b>");
});

test("fetched once a session, and only for accounts that use it", async () => {
  await sig().refreshGmailOnce("a1");
  await sig().refreshGmailOnce("a1");
  sig().update("a2", { newMessages: "none", replies: "custom" });
  await sig().refreshGmailOnce("a2");
  expect(fetches).toEqual(["a1"]);
});

test("the body: a line to type on, then the signature, which doesn't count as typing", () => {
  expect(bodyWithSignature(null)).toBe("");
  const body = bodyWithSignature('<b onclick="x()">Me</b><script>bad()</script>');
  expect(body).toBe(
    '<p></p><div class="gmail_signature" data-smartmail="gmail_signature"><b>Me</b></div>',
  );
  expect(withoutSignature(body)).toBe("<p></p>");
  expect(hasContent("<p>&nbsp;</p>")).toBe(false);
});
