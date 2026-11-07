import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useToastStore } from "../components/ui/Toast";
import type { LabelInfo } from "../lib/tauri";
import { __resetLabelStoreForTests, useLabelStore } from "../store/labelStore";
import { applyLabelEdit, editLabel } from "./edit";

const label = (id: string, name: string, over: Partial<LabelInfo> = {}): LabelInfo => ({
  id,
  accountId: "a1",
  name,
  type: "user",
  messagesTotal: 0,
  messagesUnread: 0,
  threadsTotal: 0,
  threadsUnread: 0,
  colorBackground: null,
  colorText: null,
  messageListVisibility: "show",
  labelListVisibility: "labelShow",
  ...over,
});

const LABELS = [
  label("L_test", "test"),
  label("L_sub", "test/test 2"),
  label("L_deep", "test/test 2/deep"),
  label("L_other", "tests"),
];

let answer: { resolve(v: unknown): void; reject(e: unknown): void } | null;

beforeEach(() => {
  __resetLabelStoreForTests();
  useToastStore.setState({ toasts: [] });
  answer = null;
  mockIPC((cmd) => {
    if (cmd === "update_label")
      return new Promise((resolve, reject) => {
        answer = { resolve, reject };
      });
    return undefined;
  });
  useLabelStore.setState({ labels: { a1: LABELS } });
});
afterEach(() => clearMocks());

const names = () => useLabelStore.getState().labels.a1.map((l) => l.name);
const byId = (id: string) => useLabelStore.getState().labels.a1.find((l) => l.id === id);

test("applyLabelEdit sets colour and visibility, and a rename carries its sublabels", () => {
  const coloured = applyLabelEdit(LABELS, "L_test", {
    color: { background: "#16a766", text: "#ffffff" },
    labelListVisibility: "labelHide",
  });
  expect(coloured[0]).toMatchObject({
    colorBackground: "#16a766",
    colorText: "#ffffff",
    labelListVisibility: "labelHide",
  });
  expect(applyLabelEdit(coloured, "L_test", { clearColor: true })[0].colorBackground).toBeNull();
  expect(applyLabelEdit(LABELS, "L_test", { name: "Work/test" }).map((l) => l.name)).toEqual([
    "Work/test",
    "Work/test/test 2",
    "Work/test/test 2/deep",
    "tests",
  ]);
  expect(applyLabelEdit(LABELS, "gone", { name: "x" })).toBe(LABELS);
});

test("an edit shows before Gmail answers and stays once it does", async () => {
  const done = editLabel("a1", "L_test", { labelListVisibility: "labelHide" });
  expect(byId("L_test")?.labelListVisibility).toBe("labelHide");
  await vi.waitFor(() => expect(answer).not.toBeNull());
  answer?.resolve([{ ...LABELS[0], labelListVisibility: "labelHide" }]);
  await expect(done).resolves.toBe(true);
  expect(byId("L_test")?.labelListVisibility).toBe("labelHide");
  expect(useToastStore.getState().toasts).toEqual([]);
});

test("a refused rename puts every name back and shows Gmail's message", async () => {
  const done = editLabel("a1", "L_test", { name: "renamed" });
  expect(names()).toEqual(["renamed", "renamed/test 2", "renamed/test 2/deep", "tests"]);
  await vi.waitFor(() => expect(answer).not.toBeNull());
  answer?.reject({ code: "gmail", message: "Gmail is rate limiting this account" });
  await expect(done).resolves.toBe(false);
  expect(names()).toEqual(["test", "test/test 2", "test/test 2/deep", "tests"]);
  expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual([
    "Gmail is rate limiting this account",
  ]);
});
