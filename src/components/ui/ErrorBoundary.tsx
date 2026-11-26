import { Component, type ReactNode, Suspense, useId, useLayoutEffect, useState } from "react";
import { useComposeStore } from "../../compose/composeStore";
import { cx } from "../../lib/utils";
import { Button } from "./Button";
import { Modal } from "./Modal";
import "./ErrorBoundary.css";
import "./Surface.css";

interface ErrorBoundaryProps {
  children: ReactNode;
  title: string;
  /** A new selection can recover a pane that failed on the previous one. */
  resetKey?: string | null;
  className?: string;
  reloadOnly?: boolean;
  recovery?: { label: string; run(): void };
  /** Floating surfaces can be dismissed independently of the app. */
  onClose?(): void;
}

interface ErrorBoundaryState {
  failure: "render" | "load" | null;
  reload: "saving" | "failed" | null;
}

class SurfaceLoadError extends Error {
  constructor(readonly cause: unknown) {
    super("Couldn't load the component");
  }
}

/** React.lazy remembers a rejected import for the whole session. Reload to request that chunk again. */
export function surfaceLoader<T>(load: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await load();
    } catch (cause) {
      throw new SurfaceLoadError(cause);
    }
  };
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failure: null, reload: null };
  private reloadPending = false;

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { failure: error instanceof SurfaceLoadError ? "load" : "render", reload: null };
  }

  componentDidUpdate(previous: ErrorBoundaryProps) {
    if (this.state.failure === "render" && previous.resetKey !== this.props.resetKey) this.retry();
  }

  componentWillUnmount() {
    this.reloadPending = false;
  }

  private retry = () => {
    if (this.reloadPending) return;
    this.setState({ failure: null, reload: null });
  };

  private reload = async () => {
    if (this.reloadPending) return;
    this.reloadPending = true;
    this.setState({ reload: "saving" });
    const saved = await useComposeStore
      .getState()
      .saveAll({ focusOnFailure: false })
      .catch(() => false);
    if (!this.reloadPending) return;
    // A compose window beside a failed pane can change while another draft is saving.
    const busy = useComposeStore
      .getState()
      .windows.some(
        (win) => !win.loading && (win.version !== win.savedVersion || win.attaching || win.sending),
      );
    if (saved && !busy) window.location.reload();
    else {
      this.reloadPending = false;
      this.setState({ reload: "failed" });
    }
  };

  render() {
    const { children, title, className, reloadOnly, recovery, onClose } = this.props;
    const { failure, reload } = this.state;
    if (!failure) return children;
    const saving = reload === "saving";
    const close =
      onClose &&
      (() => {
        if (!this.reloadPending) onClose();
      });
    const actions = (
      <>
        <div className="surface-error__actions">
          {!reloadOnly && failure === "render" && (
            <Button size="sm" variant="primary" aria-disabled={saving} onClick={this.retry}>
              Try again
            </Button>
          )}
          <Button size="sm" aria-disabled={saving} onClick={() => void this.reload()}>
            {saving ? "Saving drafts…" : "Reload app"}
          </Button>
          {recovery && (
            <Button
              size="sm"
              variant="ghost"
              aria-disabled={saving}
              onClick={() => {
                if (!this.reloadPending) recovery.run();
              }}
            >
              {recovery.label}
            </Button>
          )}
          {close && (
            <Button size="sm" variant="ghost" aria-disabled={saving} onClick={close}>
              Close
            </Button>
          )}
        </div>
        {reload === "failed" && <p role="alert">Couldn't save a draft. Pheeme stayed open.</p>}
      </>
    );
    if (close)
      return (
        <DialogError title={title} onClose={close}>
          {actions}
        </DialogError>
      );
    return (
      <div className={cx("surface-error", reloadOnly && "surface-error--root", className)}>
        <p className="surface-error__title" role="alert">
          {title}
        </p>
        {actions}
      </div>
    );
  }
}

interface LazyDialogProps {
  title: string;
  loadingTitle: string;
  onClose(): void;
  children: ReactNode;
}

export function LazyDialog({ title, loadingTitle, onClose, children }: LazyDialogProps) {
  // A loaded dialog can mount while the loading dialog still owns focus. Remember the
  // actual opener across loading, success and error, including an iframe in the reading pane.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useLayoutEffect(() => {
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);

  return (
    <ErrorBoundary title={title} onClose={onClose}>
      <Suspense fallback={<PendingDialog title={loadingTitle} onClose={onClose} />}>
        {children}
      </Suspense>
    </ErrorBoundary>
  );
}

function PendingDialog({ title, onClose }: { title: string; onClose(): void }) {
  const titleId = useId();
  return (
    <Modal
      title={title}
      titleId={titleId}
      titleClassName="surface-error__title"
      className="surface-error dialog-surface"
      scrimClassName="dialog-scrim"
      onClose={onClose}
    >
      <Button size="sm" data-autofocus="" onClick={onClose}>
        Cancel
      </Button>
    </Modal>
  );
}

function DialogError({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <Modal
      title={title}
      titleId={titleId}
      titleClassName="surface-error__title"
      className="surface-error dialog-surface"
      scrimClassName="dialog-scrim"
      onClose={onClose}
    >
      {children}
    </Modal>
  );
}
