---
name: release
description: >-
  Cut a Pheeme release: version bump, release notes, website roadmap, tag,
  publish. Use when Alex says to cut, ship, or tag a release, or when a phase
  has merged (each phase ships as a 0.x beta).
---

# Releasing Pheeme

A release is a `release: vX.Y` PR (version bump + `docs/releases/vX.Y.md`), then the tag `vX.Y` on
its merge commit. The tag runs `.github/workflows/release.yml`: it refuses a tag whose notes aren't
finished, builds every platform (15–27 min), and publishes the notes as the GitHub release text.
Installed apps auto-update from that release, and pheeme.app/changelog lists it with no site edit.

Versions are `MAJOR.MINOR` (files store `X.Y.0`). Betas go up by one minor: v0.7 → v0.8.

## Steps

1. **Ready.** Everything meant to ship is merged into `main`, and `main`'s latest CI run is green
   (`gh run list --branch main -L 5`). Done when both hold. Otherwise merge or wait first.
2. **Prepare.** From an up-to-date main: `wt switch -c release/vX.Y`, then
   `npm run release:prepare -- X.Y`. It sets the version in all five files and drafts
   `docs/releases/vX.Y.md` from the PRs merged since the last tag, with a Heads-up if a database
   migration was added.
3. **Write the notes.** Read each PR the DRAFT block lists (`gh pr view <n>`) and write for people
   using the app. Match `docs/releases/v0.7.md`:
   - one line saying what the release is about
   - a **bold heading** per area, with bullets on what you can do now; keys in backticks (`r`, `mod+Enter`)
   - the **Heads-up** stays whenever prepare added one (an older version can't open a cache a newer
     one migrated)
   - leave out PRs under "Behind the scenes" unless people notice them (speed, memory, fixes)

   Done when `npm run release:check -- X.Y` prints `vX.Y is ready to tag`.
4. **Website.** If this release finishes an item on the roadmap (`#roadmap` in
   `site/public/index.html`), stamp it: that `<li>` gets `class="done"` and the `DONE` postmark,
   and the next item gets `class="next"` and `NEXT`. The site deploys when the release PR merges.
5. **Tracking.** Tick the shipped items on the phase issue and update the status line of epic #21.
6. **Release PR.** Commit as `release: vX.Y`, open a PR with that title and the notes
   (`node scripts/release.mjs notes X.Y`) as its body, and merge it once CI is green (the
   `babysit` skill watches and squash-merges).
7. **Tag.** `git fetch origin`, then tag the release commit on main and push the tag:
   `git tag vX.Y <sha> && git push origin vX.Y`. Watch the Release run until it publishes
   (`babysit` covers workflow runs).
8. **Confirm.** Done when `gh release view vX.Y` shows the notes, the installers and `latest.json`,
   and Alex has heard that it's out (auto-update on his Mac picks it up).

## When it goes wrong

- **Verify fails on the tag** (notes unfinished or versions off): delete the tag
  (`git push --delete origin vX.Y && git tag -d vX.Y`), fix it on main through a PR, tag again.
  A re-run reuses the existing draft release.
- **A build fails after the draft exists:** fix on main, move the tag to the new commit
  (`git tag -f`, `git push -f origin vX.Y`), and re-run the workflow. Nothing was published.
- **Notes need a fix after publishing:** edit `docs/releases/vX.Y.md` through a PR, then
  `gh release edit vX.Y --notes-file <(node scripts/release.mjs notes X.Y)`.
