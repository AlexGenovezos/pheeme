import { type ReactNode, type Ref, useId } from "react";

export function Section({
  title,
  action,
  children,
  sectionRef,
}: {
  title: string;
  /** A button beside the heading. */
  action?: ReactNode;
  children: ReactNode;
  sectionRef?: Ref<HTMLElement>;
}) {
  const id = useId();
  const heading = (
    <h2 id={id} className="sidebar__heading">
      {title}
    </h2>
  );
  return (
    <section ref={sectionRef} className="sidebar__section" aria-labelledby={id}>
      {action ? (
        <div className="sidebar__heading-row">
          {heading}
          {action}
        </div>
      ) : (
        heading
      )}
      {children}
    </section>
  );
}
