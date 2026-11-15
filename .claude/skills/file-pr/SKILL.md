---
name: file-pr
description: File a Pheeme pull request, with screenshots when it changes the UI. Use when asked to file, open, or create a PR in this repo.
---

# File a Pheeme PR

## Steps

1. **Check** that no PR exists for this branch. Rebase onto `origin/main` and read the diff against
   it: its contents match the goal.
2. **Screenshots**, when the diff changes what the user sees (components, CSS, the site): take them
   now, as in [Screenshots](#screenshots).
3. **Write** the title and body ([Title and body](#title-and-body)), then `gh pr create` (a real PR,
   not a draft).
4. **Attach** the screenshots: upload them with the PR number and add the printed Markdown under a
   `## Screenshots` heading (`gh pr edit <n> --body-file …`). Done when every changed screen is in
   the PR body, or the body says why one can't be shown.

## Screenshots

This is a public repo: screenshots show preview fixture data, never a real mailbox.

- **Source:** the browser preview. `npx vite --port <free port> --strictPort --host 127.0.0.1`
  answers every command from `src/preview/` fixtures. Drive it with Playwright from the repo's
  `node_modules` (`import { chromium } from "<repo>/node_modules/playwright/index.mjs"`), with the
  script under `$TMPDIR`, outside the repo. When the change needs data the fixtures lack (a field,
  an event, a state), extend `src/preview/` in the PR: the preview then shows it to everyone.
- **Stable frames:** viewport 1280×820, `timezoneId: "UTC"`, `page.clock.setFixedTime(…)` (the
  calendar fixtures are a week around "now"), and `localStorage` set in `addInitScript`:
  `pheeme.theme-mode` = `light`, and `pheeme.calendar` = `{"mode":"calendar","view":"week"}` for
  Calendar. `locator.screenshot()` crops to the part that changed.
- **Before and after:** a change to existing UI gets both. Take "before" ahead of editing, or from
  a `wt` worktree of `origin/main`.
- **Look** at every PNG (Read it) before uploading: it shows the change, nothing overlaps or is cut
  off.
- **Upload:** `.claude/skills/file-pr/scripts/upload-screenshots.sh <pr> <file.png>…` commits them
  to the `pr-screenshots` branch (images only; no workflow runs on it) and prints one Markdown image
  per file, pinned to that commit.
- **Native-only UI** (tray, notifications, window chrome) that the preview can't render: use the
  `mac-dev` skill for a screenshot, or say in the body why there is none.

## Title and body

Titles become squash-merge commit messages: follow recent `git log` (`feat(scope): …`), human
readable, saying why the change matters.

Open the body with the problem in the user's terms, then the solution in a few lines; no
implementation inventory up front. Add one line on how you proved the change, then any review line
(`Reviewed with sol-loop: …`), `Closes #<issue>`, and last the model and harness that wrote it
(`Created with <model> in <harness>.`, including subagent models).

Before submitting, check the title, body and screenshots for secrets and private details.
