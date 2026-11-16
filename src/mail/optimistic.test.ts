// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";
import { useLabelStore } from "../store/labelStore";
import { useMailStore } from "../store/mailStore";
import { useThreadStore } from "../store/threadStore";
import { OptimisticOp } from "./optimistic";

afterEach(() => vi.restoreAllMocks());

function spies() {
  return {
    settle: vi.spyOn(useMailStore.getState(), "settle").mockImplementation(() => {}),
    settleDetails: vi
      .spyOn(useThreadStore.getState(), "settleDetails")
      .mockImplementation(() => {}),
    settleUnread: vi.spyOn(useLabelStore.getState(), "settleUnread").mockImplementation(() => {}),
  };
}

test("settling releases rows and details per key, and the counts once every key has settled", () => {
  const { settle, settleDetails, settleUnread } = spies();
  const op = new OptimisticOp(["a:t1", "b:t2"]);
  op.settle(["a:t1"], false);
  const id = settle.mock.calls[0][0];
  expect(settle).toHaveBeenLastCalledWith(id, ["a:t1"], false);
  expect(settleDetails).toHaveBeenLastCalledWith(id, ["a:t1"]);
  expect(settleUnread).not.toHaveBeenCalled();
  op.settle(["b:t2"], true);
  expect(settle).toHaveBeenLastCalledWith(id, ["b:t2"], true);
  expect(settleDetails).toHaveBeenLastCalledWith(id, ["b:t2"]);
  expect(settleUnread).toHaveBeenCalledExactlyOnceWith(id);
  // Settling again releases the rows but never the counts twice.
  op.settle(["a:t1"], true);
  expect(settleUnread).toHaveBeenCalledOnce();
});

test("each op has its own id", () => {
  const { settle } = spies();
  new OptimisticOp(["a:t1"]).settle(["a:t1"], false);
  new OptimisticOp(["a:t1"]).settle(["a:t1"], false);
  expect(settle.mock.calls[0][0]).not.toBe(settle.mock.calls[1][0]);
});
