import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "../../lib/utils";
import "./ListRow.css";

export interface ListRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
  leading?: ReactNode;
  /** Right of the title (time, count). */
  meta?: ReactNode;
  /** Second line (subject). */
  subtitle?: ReactNode;
  /** Third line (snippet), single-line ellipsis. */
  description?: ReactNode;
  selected?: boolean;
  unread?: boolean;
  density?: "compact" | "comfortable";
}

/**
 * A selectable row for lists and the sidebar. The container owns keyboard
 * navigation and sets `role`; rows default to `option` for listboxes.
 */
export const ListRow = forwardRef<HTMLDivElement, ListRowProps>(function ListRow(
  {
    title,
    leading,
    meta,
    subtitle,
    description,
    selected,
    unread,
    density = "comfortable",
    className,
    role = "option",
    ...rest
  },
  ref,
) {
  return (
    <div
      ref={ref}
      role={role}
      aria-selected={role === "option" ? Boolean(selected) : undefined}
      aria-current={role !== "option" && selected ? "true" : undefined}
      data-selected={selected || undefined}
      data-unread={unread || undefined}
      className={cx("ui-row", `ui-row--${density}`, className)}
      {...rest}
    >
      {density === "comfortable" && <span className="ui-row__unread" aria-hidden="true" />}
      {leading && <span className="ui-row__leading">{leading}</span>}
      <span className="ui-row__body">
        <span className="ui-row__line">
          <span className="ui-row__title">{title}</span>
          {meta != null && <span className="ui-row__meta">{meta}</span>}
        </span>
        {subtitle != null && <span className="ui-row__subtitle">{subtitle}</span>}
        {description != null && <span className="ui-row__description">{description}</span>}
      </span>
    </div>
  );
});
