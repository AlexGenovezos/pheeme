import type { MouseEvent } from "react";
import type { NotesInline } from "../../scripts/release-notes.mjs";
import { Badge } from "../components/ui/Badge";
import { openExternal } from "../lib/tauri";
import { displayVersion } from "../lib/updater";
import type { Release } from "./releases";

function openLink(e: MouseEvent<HTMLAnchorElement>) {
  e.preventDefault();
  void openExternal(e.currentTarget.href).catch(() => {});
}

function Inline({ content }: { content: NotesInline[] }) {
  return content.map((piece, i) => {
    switch (piece.type) {
      case "text":
        return piece.text;
      case "bold":
        return <strong key={i}>{piece.text}</strong>;
      case "code":
        return (
          <code key={i} className="release-notes__code">
            {piece.text}
          </code>
        );
      case "link":
        return (
          <a key={i} href={piece.href} onClick={openLink}>
            {piece.text}
          </a>
        );
    }
  });
}

/** Every release's notes as its own card, newest first; `current` is marked as the running version. */
export function ReleaseNotes({ releases, current }: { releases: Release[]; current: string }) {
  return (
    <div className="release-notes-list">
      {releases.map((release) => (
        <ReleaseCard key={release.version} release={release} current={current} />
      ))}
    </div>
  );
}

function ReleaseCard({
  release: { version, blocks },
  current,
}: {
  release: Release;
  current: string;
}) {
  return (
    <article className="settings-card release-notes" aria-label={`Version ${version}`}>
      <h4 className="release-notes__version">
        Version {version}
        {version === displayVersion(current) && <Badge tone="accent">This version</Badge>}
      </h4>
      <div className="release-notes__body">
        {blocks.map((block, i) => {
          switch (block.type) {
            case "heading":
              return (
                <h5 key={i} className="release-notes__heading">
                  {block.text}
                </h5>
              );
            case "paragraph":
              return (
                <p key={i} className="release-notes__lead">
                  <Inline content={block.content} />
                </p>
              );
            case "list":
              return (
                <ul key={i} className="release-notes__list">
                  {block.items.map((item, j) => (
                    <li key={j}>
                      <Inline content={item} />
                    </li>
                  ))}
                </ul>
              );
          }
        })}
      </div>
    </article>
  );
}
