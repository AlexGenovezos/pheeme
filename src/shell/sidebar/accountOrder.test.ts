import type { PointerEvent as ReactPointerEvent } from "react";
import { expect, test } from "vitest";
import { useAccountStore } from "../../store/accountStore";
import { dropped, moved, startAccountDrag, useAccountDrag } from "./accountOrder";

test("Move up and Move down step an account one place, and stop at the ends", () => {
  const ids = ["a", "b", "c"];
  expect(moved(ids, "b", -1)).toEqual(["b", "a", "c"]);
  expect(moved(ids, "b", 1)).toEqual(["a", "c", "b"]);
  expect(moved(ids, "a", -1)).toBe(ids);
  expect(moved(ids, "c", 1)).toBe(ids);
  expect(moved(ids, "gone", 1)).toBe(ids);
});

test("a dragged account lands before the first account whose middle is below the pointer", () => {
  const ids = ["a", "b", "c"];
  const middles = { a: 10, b: 30, c: 50 };
  expect(dropped(ids, "c", middles, 5)).toEqual(["c", "a", "b"]);
  expect(dropped(ids, "c", middles, 20)).toEqual(["a", "c", "b"]);
  expect(dropped(ids, "a", middles, 60)).toEqual(["b", "c", "a"]);
  // Over its own place: where it was.
  expect(dropped(ids, "b", middles, 30)).toEqual(ids);
});

const press = (pointerType: string) =>
  ({ button: 0, clientX: 0, clientY: 0, pointerType }) as unknown as ReactPointerEvent;

test("a drag ends when the window loses focus, and touch never starts one", () => {
  useAccountStore.setState({
    accounts: [{ id: "a" }, { id: "b" }] as ReturnType<typeof useAccountStore.getState>["accounts"],
  });
  startAccountDrag(press("mouse"), "a");
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: 0, clientY: 50 }));
  expect(useAccountDrag.getState().dragging).toBe("a");
  window.dispatchEvent(new Event("blur"));
  expect(useAccountDrag.getState()).toEqual({ dragging: null, order: null });

  startAccountDrag(press("touch"), "a");
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: 0, clientY: 50 }));
  expect(useAccountDrag.getState().dragging).toBeNull();
});
