import { version as appVersion } from "../../package.json";
import { isNewer, type NotesBlock, parseNotes } from "../../scripts/release-notes.mjs";
import RELEASE_DATES from "../../docs/releases/dates.json";
import { displayVersion } from "../lib/updater";

export interface Release {
  /** Public version, e.g. "0.8". */
  version: string;
  /** When the release went out (ISO 8601), or null when it isn't known. */
  date: string | null;
  blocks: NotesBlock[];
}

/** docs/releases/vX.Y.md, baked into the build so the notes need no network. */
const FILES = import.meta.glob<string>("../../docs/releases/v*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * Releases up to `current`, newest first. Notes for a later version (written before its release)
 * are left out. `files` maps a path ending in `vX.Y.md` to its text; `dates` maps "X.Y" to when
 * that version went out.
 */
export function releasesFrom(
  files: Record<string, string>,
  current: string,
  dates: Record<string, string> = {},
): Release[] {
  return Object.entries(files)
    .flatMap(([path, text]) => {
      const version = /\/v(\d+\.\d+)\.md$/.exec(path)?.[1];
      return version && !isNewer(version, current)
        ? [{ version, date: dates[version] ?? null, blocks: parseNotes(text).blocks }]
        : [];
    })
    .sort((a, b) => (isNewer(a.version, b.version) ? -1 : 1));
}

/**
 * docs/releases/dates.json holds when each published release went out (`release:prepare` adds
 * them); the release build stamps its own version with when its tag was pushed, since its date
 * can't be in the file it is built from.
 */
export function releaseDates(
  recorded: Record<string, string>,
  current: string,
  pushedAt: string | undefined,
): Record<string, string> {
  const version = displayVersion(current);
  return pushedAt && !recorded[version] ? { ...recorded, [version]: pushedAt } : recorded;
}

export const RELEASES = releasesFrom(
  FILES,
  appVersion,
  releaseDates(RELEASE_DATES, appVersion, import.meta.env.VITE_RELEASE_PUSHED_AT),
);
