import { useState } from "react";
import { AVATAR_COLOR_COUNT } from "../../styles/themes";
import { cx } from "../../lib/utils";
import "./Avatar.css";

/** "Mira Okafor" → "MO"; "notifications@github.com" → "N". */
export function initialsFor(name: string): string {
  const base = name.includes("@") && !name.includes(" ") ? name.split("@")[0] : name;
  const words = base.split(/[\s._-]+/).filter((w) => /\p{L}|\p{N}/u.test(w));
  if (!words.length) return "?";
  const first = [...words[0]][0];
  const last = words.length > 1 ? [...words[words.length - 1]][0] : "";
  return (first + last).toUpperCase();
}

/** Stable color slot 1..AVATAR_COLOR_COUNT for a sender, so a person keeps their color. */
export function avatarColorIndex(seed: string): number {
  let h = 0;
  for (const ch of seed.toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return (h % AVATAR_COLOR_COUNT) + 1;
}

export interface AvatarProps {
  name: string;
  /** Used for the color seed when present, so "Mira" and "mira@…" match. */
  email?: string;
  src?: string;
  size?: "sm" | "md";
  className?: string;
}

export function Avatar({ name, email, src, size = "md", className }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const color = avatarColorIndex(email ?? name);
  return (
    <span
      className={cx("ui-avatar", `ui-avatar--${size}`, className)}
      style={{ background: `var(--color-avatar-${color})` }}
      role="img"
      aria-label={name}
    >
      {src && !failed ? (
        <img src={src} alt="" draggable={false} onError={() => setFailed(true)} />
      ) : (
        <span aria-hidden="true">{initialsFor(name)}</span>
      )}
    </span>
  );
}
