import { beforeEach, expect, test } from "vitest";
import type { AttachmentInfo } from "../../lib/tauri";
import { usePreviewStore } from "./previewStore";

const file = (id: string): AttachmentInfo => ({
  id,
  filename: `${id}.pdf`,
  mimeType: "application/pdf",
  size: 1,
  isInline: false,
  contentId: null,
});

beforeEach(() => usePreviewStore.setState({ session: null }));

test("stepping wraps around both ends", () => {
  const { open, step } = usePreviewStore.getState();
  open({ accountId: "a", messageId: "m", files: [file("a"), file("b"), file("c")], index: 0 });
  step(-1);
  expect(usePreviewStore.getState().session?.index).toBe(2);
  step(1);
  step(1);
  expect(usePreviewStore.getState().session?.index).toBe(1);
  usePreviewStore.getState().close();
  expect(usePreviewStore.getState().session).toBeNull();
});
