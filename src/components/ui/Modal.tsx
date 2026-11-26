// A modal dialog shell: scrim, focus trap, Esc closes, keys belong to it while it's open, and
// focus goes back to whatever opened it. Callers give it their look with class names.
import { type KeyboardEvent, type ReactNode, useRef } from "react";
import { trapTab, useDialogFocus } from "./useDialogFocus";

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
  useDialogFocus(ref, { returnTo });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Portals still bubble through their React parents (including compose's Send shortcut).
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    trapTab(e, ref.current);
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
