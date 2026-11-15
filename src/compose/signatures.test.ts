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

test("choices are saved in the app, and ones kept only in this window move there once", async () => {
  const saved: Record<string, unknown> = {
    a2: { newMessages: "none", replies: "custom", custom: "<p>From the app</p>" },
  };
  mockIPC((cmd, args) => {
    const { accountId, settings } = args as { accountId: string; settings?: unknown };
    if (cmd === "signature_settings") return saved[accountId] ?? null;
    if (cmd === "set_signature_settings") saved[accountId] = settings;
    return undefined;
  });
  // From before the move: only in localStorage.
  localStorage.setItem(
    "pheeme.signatures",
    JSON.stringify({ a1: { newMessages: "custom", replies: "gmail", custom: "<p>Old</p>" } }),
  );
  __resetSignaturesForTests();

  await sig().loadSaved(["a1", "a2", "a3"]);
  expect(saved.a1).toEqual({ newMessages: "custom", replies: "gmail", custom: "<p>Old</p>" });
  expect(sig().forAccount("a2").custom).toBe("<p>From the app</p>");
  expect(sig().signatureFor("a2", "reply")).toBe("<p>From the app</p>");
  expect(saved.a3).toBeUndefined(); // nothing to move, so defaults stay unsaved

  sig().update("a3", { newMessages: "none" });
  await Promise.resolve();
  expect(saved.a3).toEqual({ newMessages: "none", replies: "gmail", custom: "" });
  // The window keeps a copy for panels opened before the next load.
  expect(JSON.parse(localStorage.getItem("pheeme.signatures") ?? "{}").a2.custom).toBe(
    "<p>From the app</p>",
  );
});
