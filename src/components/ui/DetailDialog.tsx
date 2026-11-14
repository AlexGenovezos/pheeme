import { X } from "lucide-react";
import { type ReactNode, useId } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./IconButton";
import { Modal } from "./Modal";
import "./DetailDialog.css";

/** A bounded detail window for contextual files and people, with the app's modal key handling. */
export function DetailDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  const titleId = useId();
  return createPortal(
    <Modal
      title={title}
      titleId={titleId}
      onClose={onClose}
      className="detail-dialog"
      scrimClassName="detail-dialog-scrim"
      titleClassName="detail-dialog__title"
      titleActions={<IconButton label="Close" icon={<X />} onClick={onClose} />}
    >
      {children}
    </Modal>,
    document.body,
  );
}
