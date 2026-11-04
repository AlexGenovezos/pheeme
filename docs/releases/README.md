# Release notes

One file per release, `vX.Y.md`. The release workflow publishes it as the GitHub release text,
which pheeme.app/changelog shows; the app bundles the files and shows them in Settings › About.
They use the small Markdown subset `scripts/release-notes.mjs` reads, which `release:check` enforces. A tag can't be released without its file:
`npm run release:check -- X.Y` (run by the workflow too) fails while it's missing, empty, or still
has a TODO or the DRAFT block that `npm run release:prepare -- X.Y` starts it with.

How to cut a release: `.claude/skills/release/SKILL.md`.
