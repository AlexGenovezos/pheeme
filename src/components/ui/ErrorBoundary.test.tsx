import { act, fireEvent, render, screen } from "@testing-library/react";
import { lazy, Suspense, useState } from "react";
import { expect, test, vi } from "vitest";
import { useComposeStore } from "../../compose/composeStore";
import { registry } from "../../keyboard/registry";
import { ErrorBoundary, LazyDialog, surfaceLoader } from "./ErrorBoundary";
import { Modal } from "./Modal";

function Pane({ fail = false }: { fail?: boolean }) {
  if (fail) throw new Error("render failed");
  return <p>Conversation contents</p>;
}

test("a failed pane leaves its siblings visible and can retry", () => {
  const frame = (fail: boolean) => (
    <>
      <p>Conversation list</p>
      <ErrorBoundary title="Couldn't show the conversation">
        <Pane fail={fail} />
      </ErrorBoundary>
    </>
  );
  const { rerender } = render(frame(true), { onCaughtError: vi.fn() });
  expect(screen.getByRole("alert")).toHaveTextContent("Couldn't show the conversation");
  expect(screen.getByText("Conversation list")).toBeVisible();
  rerender(frame(false));
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByText("Conversation contents")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a different selection recovers a failed pane", () => {
  const frame = (key: string) => (
    <ErrorBoundary title="Couldn't show the conversation" resetKey={key}>
      <Pane fail={key === "first"} />
    </ErrorBoundary>
  );
  const { rerender } = render(frame("first"), { onCaughtError: vi.fn() });
  expect(screen.getByRole("alert")).toBeVisible();
  rerender(frame("next"));
  expect(screen.getByText("Conversation contents")).toBeVisible();
});

test("a failed dialog can be closed with Escape", () => {
  const close = vi.fn();
  render(
    <ErrorBoundary title="Couldn't open Settings" onClose={close}>
      <Pane fail />
    </ErrorBoundary>,
    { onCaughtError: vi.fn() },
  );
  const dialog = screen.getByRole("dialog", { name: "Couldn't open Settings" });
  expect(dialog).toHaveFocus();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});

test("a failed lazy import offers a reload", async () => {
  const LazyPane = lazy(surfaceLoader(() => Promise.reject(new Error("chunk unavailable"))));
  render(
    <ErrorBoundary title="Couldn't open Calendar">
      <Suspense fallback={null}>
        <LazyPane />
      </Suspense>
    </ErrorBoundary>,
    { onCaughtError: vi.fn() },
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't open Calendar");
  expect(screen.getByRole("button", { name: "Reload app" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

test("reloading waits for the draft save and stays open when saving fails", async () => {
  let finishSave!: (saved: boolean) => void;
  const save = vi.spyOn(useComposeStore.getState(), "saveAll").mockReturnValue(
    new Promise((resolve) => {
      finishSave = resolve;
    }),
  );
  render(
    <ErrorBoundary title="Couldn't open Settings">
      <Pane fail />
    </ErrorBoundary>,
    { onCaughtError: vi.fn() },
  );
  fireEvent.click(screen.getByRole("button", { name: "Reload app" }));
  expect(save).toHaveBeenCalledWith({ focusOnFailure: false });
  expect(screen.getByRole("button", { name: "Saving drafts…" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  finishSave(false);
  expect(await screen.findByText("Couldn't save a draft. Pheeme stayed open.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Reload app" })).toBeVisible();
});

test("a pending dialog takes focus from an iframe, blocks shortcuts and cancels with Escape", () => {
  const run = vi.fn();
  const unregister = registry.register({ id: "pending-test", title: "Test", shortcut: "e", run });
  const Loading = lazy(() => new Promise<never>(() => {}));
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <iframe title="Email body" />
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
        {open && (
          <LazyDialog
            title="Couldn't open Settings"
            loadingTitle="Opening Settings…"
            onClose={() => setOpen(false)}
          >
            <Loading />
          </LazyDialog>
        )}
      </>
    );
  }
  const route = (event: KeyboardEvent) => registry.handleKeyDown(event);
  window.addEventListener("keydown", route);
  try {
    render(<Harness />);
    const iframe = screen.getByTitle("Email body");
    iframe.focus();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(window, { key: "e" });
    expect(run).not.toHaveBeenCalled();
    fireEvent.keyDown(cancel, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(iframe).toHaveFocus();
    fireEvent.keyDown(window, { key: "e" });
    expect(run).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener("keydown", route);
    unregister();
  }
});

test("a loaded dialog returns focus to the opener it shared with the loading dialog", async () => {
  let finishLoading!: () => void;
  const loading = new Promise<void>((resolve) => {
    finishLoading = resolve;
  });
  const Loaded = lazy(async () => {
    await loading;
    return {
      default: ({ onClose }: { onClose(): void }) => (
        <Modal
          title="Settings"
          titleId="test-settings"
          className=""
          titleClassName=""
          scrimClassName=""
          onClose={onClose}
        >
          <button type="button" onClick={onClose}>
            Close
          </button>
        </Modal>
      ),
    };
  });
  const { rerender } = render(<button type="button">Opener</button>);
  const opener = screen.getByRole("button", { name: "Opener" });
  opener.focus();
  rerender(
    <>
      <button type="button">Opener</button>
      <LazyDialog
        title="Couldn't open Settings"
        loadingTitle="Opening Settings…"
        onClose={() => rerender(<button type="button">Opener</button>)}
      >
        <Loaded onClose={() => rerender(<button type="button">Opener</button>)} />
      </LazyDialog>
    </>,
  );
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  await act(async () => finishLoading());
  expect(await screen.findByRole("dialog", { name: "Settings" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.getByRole("button", { name: "Opener" })).toHaveFocus();
});
