import { beforeEach, expect, test } from "vitest";
import { __resetComposeSettingsForTests, useComposeSettings } from "./composeSettings";

beforeEach(() => {
  localStorage.clear();
  __resetComposeSettingsForTests();
});

test("defaults: Reply first, no confirmation", () => {
  const s = useComposeSettings.getState();
  expect(s.defaultReply).toBe("reply");
  expect(s.confirmSend).toBe(false);
});

test("default reply and confirm before sending round-trip through localStorage", () => {
  useComposeSettings.getState().setDefaultReply("replyAll");
  useComposeSettings.getState().setConfirmSend(true);
  expect(localStorage.getItem("pheeme.default-reply")).toBe("replyAll");
  expect(localStorage.getItem("pheeme.confirm-send")).toBe("true");
  useComposeSettings.setState({ defaultReply: "reply", confirmSend: false });
  __resetComposeSettingsForTests();
  expect(useComposeSettings.getState().defaultReply).toBe("replyAll");
  expect(useComposeSettings.getState().confirmSend).toBe(true);
});

test("unknown stored values fall back to the defaults", () => {
  localStorage.setItem("pheeme.default-reply", "forward");
  localStorage.setItem("pheeme.confirm-send", "maybe");
  __resetComposeSettingsForTests();
  expect(useComposeSettings.getState().defaultReply).toBe("reply");
  expect(useComposeSettings.getState().confirmSend).toBe(false);
});
