// A modal dialog shell: scrim, focus trap, Esc closes, keys belong to it while it's open, and
// focus goes back to whatever opened it. Callers give it their look with class names.
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { registry } from "../../keyboard/registry";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  title: string;
  titleId: string;
  /** Where focus goes when it closes, if not the element focused when it opened. */
  returnTo?: HTMLElement | null;
  onClose(): void;
  children: ReactNode;
  className: string;
  scrimClassName: string;
  titleClassName: string;
  /** Extra controls beside the title (a close button). */
  titleActions?: ReactNode;
}

export function Modal({
  title,
  titleId,
  returnTo,
  onClose,
  children,
  className,
  scrimClassName,
  titleClassName,
  titleActions,
}: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [returnFocus] = useState(() => {
    const opener = document.activeElement as HTMLElement | null;
    // A closing picker's own field is about to unmount: prefer what it saved, if it's still on the page.
    return returnTo?.isConnected ? returnTo : opener?.isConnected ? opener : null;
  });

  // While the dialog is open, keys belong to it.
  useEffect(() => registry.suspend(), []);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>("[data-autofocus]");
    (first ?? ref.current)?.focus();
    return () => {
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [returnFocus]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === ref.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const heading = (
    <h2 id={titleId} className={titleClassName}>
      {title}
    </h2>
  );
  return (
    <div
      className={scrimClassName}
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-labelledby={titleId}
        tabIndex={-1}
        data-owns-keys=""
        onKeyDown={onKeyDown}
      >
        {titleActions ? (
          <div className={`${titleClassName}-row`}>
            {heading}
            {titleActions}
          </div>
        ) : (
          heading
        )}
        {children}
      </div>
    </div>
  );
}
