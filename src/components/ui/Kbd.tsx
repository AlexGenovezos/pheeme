import { formatShortcut } from "../../keyboard/format";
import type { Platform } from "../../lib/platform";
import { cx } from "../../lib/utils";
import "./Kbd.css";

/** A shortcut drawn as key caps; chord steps are separated by a small gap. */
export function Kbd({
  shortcut,
  platform,
  className,
}: {
  shortcut: string;
  platform?: Platform;
  className?: string;
}) {
  const steps = formatShortcut(shortcut, platform);
  return (
    <span className={cx("ui-kbd", className)} aria-hidden="true">
      {steps.map((caps, i) => (
        <span key={i} className="ui-kbd__step">
          {caps.map((cap, j) => (
            <kbd key={j} className="ui-kbd__cap">
              {cap}
            </kbd>
          ))}
        </span>
      ))}
    </span>
  );
}
