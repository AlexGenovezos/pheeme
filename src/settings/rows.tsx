import type { ReactNode } from "react";
import { cx } from "../lib/utils";

/** A titled card of rows, the building block of every settings page. `card={false}` leaves the children to draw their own cards. */
export function SettingsSection({
  title,
  action,
  card = true,
  children,
}: {
  title: string;
  action?: ReactNode;
  card?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="settings-section" aria-label={title}>
      <div className="settings-section__header">
        <h3 className="settings-section__title">{title}</h3>
        {action}
      </div>
      {card ? <div className="settings-card">{children}</div> : children}
    </section>
  );
}

/** One row: title and description on the left, the control on the right. */
export function SettingsRow({
  title,
  description,
  control,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("settings-row", className)}>
      <div className="settings-row__text">
        <div className="settings-row__title">{title}</div>
        {description && <div className="settings-row__description">{description}</div>}
      </div>
      {control && <div className="settings-row__control">{control}</div>}
    </div>
  );
}
