import type { ReactNode } from "react";

/** A line of text in the middle of the preview area: loading, or why there's nothing to show. */
export function PreviewMessage({ busy, children }: { busy?: boolean; children: ReactNode }) {
  return (
    <div className="file-preview__message" role={busy ? "status" : undefined}>
      {busy && <span className="file-preview__spinner" aria-hidden="true" />}
      <p>{children}</p>
    </div>
  );
}
