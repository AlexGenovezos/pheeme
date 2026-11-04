import { version as appVersion } from "../../package.json";
import { isNewer, type NotesBlock, parseNotes } from "../../scripts/release-notes.mjs";

export interface Release {
  /** Public version, e.g. "0.8". */
  version: string;
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
 * are left out. `files` maps a path ending in `vX.Y.md` to its text.
 */
export function releasesFrom(files: Record<string, string>, current: string): Release[] {
  return Object.entries(files)
    .flatMap(([path, text]) => {
      const version = /\/v(\d+\.\d+)\.md$/.exec(path)?.[1];
      return version && !isNewer(version, current)
        ? [{ version, blocks: parseNotes(text).blocks }]
        : [];
    })
    .sort((a, b) => (isNewer(a.version, b.version) ? -1 : 1));
}

export const RELEASES = releasesFrom(FILES, appVersion);
