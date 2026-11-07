import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { ToastProvider, useToastStore } from "../components/ui/Toast";
import { AttachmentList } from "./AttachmentList";

beforeEach(() => useToastStore.setState({ toasts: [] }));

const files = [
  {
    id: "att1",
    filename: "plan.pdf",
    mimeType: "application/pdf",
    size: 163230,
    isInline: false,
    contentId: null,
  },
];

function renderFiles() {
  return render(
    <ToastProvider>
      <AttachmentList accountId="a1" messageId="m1" attachments={files} />
    </ToastProvider>,
  );
}

test("a slow download stays visibly in progress until the file is saved", async () => {
  let finish!: (path: string) => void;
  const pending = new Promise<string>((resolve) => {
    finish = resolve;
  });
  let downloads = 0;
  mockIPC((cmd) => {
    if (cmd === "save_attachment") {
      downloads++;
      return pending;
    }
  });
  renderFiles();
  fireEvent.click(screen.getByRole("button", { name: "Download plan.pdf" }));
  expect(screen.getByText("Downloading…")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Downloading plan.pdf" })).toBeDisabled();
  expect(screen.queryByText("Saved to Downloads")).toBeNull();
  expect(downloads).toBe(1);

  await act(async () => finish("/Users/me/Downloads/plan.pdf"));
  expect(screen.queryByText("Downloading…")).toBeNull();
  expect(screen.getByText("Saved to Downloads")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Download plan.pdf" })).toBeEnabled();
});

test("a failed download explains the failure and can be retried", async () => {
  let fail!: (error: unknown) => void;
  const pending = new Promise<string>((_, reject) => {
    fail = reject;
  });
  let downloads = 0;
  mockIPC((cmd) => {
    if (cmd === "save_attachment") {
      downloads++;
      return downloads === 1 ? pending : "/Users/me/Downloads/plan.pdf";
    }
  });
  renderFiles();
  fireEvent.click(screen.getByRole("button", { name: "Download plan.pdf" }));
  await act(async () => fail({ code: "network", message: "Gmail is unavailable." }));
  expect(screen.queryByText("Downloading…")).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent("Gmail is unavailable.");
  fireEvent.click(screen.getByRole("button", { name: "Download plan.pdf" }));
  expect(await screen.findByText("Saved to Downloads")).toBeInTheDocument();
  expect(downloads).toBe(2);
});

test("clicking a file opens the preview on it, with the message's other files to flip through", async () => {
  const { usePreviewStore } = await import("./preview/previewStore");
  usePreviewStore.setState({ session: null });
  render(
    <AttachmentList
      accountId="a1"
      messageId="m1"
      attachments={[
        ...files,
        { ...files[0], id: "logo", filename: "logo.png", isInline: true },
        { ...files[0], id: "att2", filename: "budget.xlsx" },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Preview budget.xlsx" }));
  const session = usePreviewStore.getState().session;
  expect(session?.index).toBe(1);
  expect(session?.files.map((f) => f.filename)).toEqual(["plan.pdf", "budget.xlsx"]);
  expect(session).toMatchObject({ accountId: "a1", messageId: "m1" });
});
