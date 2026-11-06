# Claude review ledger

Reviewer: Claude Opus 5.5 through the Claude CLIProxy provider. One reviewer at a time; no nested agents. Model usage and effort were not exposed. Two rounds completed. Round 1 returned CHANGES with no blockers; round 2 returned APPROVE, confirming C1–C3 and C5–C8 resolved and accepting the declined C4. No blocker or should-level finding remains.

Scope: this UI pass, its fixed scoring rubric, screenshot evidence, and comparison website. Unrelated mail, ThreadList, and label-count diffs are excluded.

| ID | Severity | Outcome |
| --- | --- | --- |
| C1 | should | Fixed. Readable subtle text and disabled controls use separate tokens. Dark subtle is darker than muted, and disabled controls retain their original dimmer colors. Regression tests check ordering and contrast. |
| C2 | should | Fixed by restoring the original Calendar setup flow and its tests/docs. The recorded product decision is preserved. O5 stays FAIL, making the unchanged score 98/100. The review's suggested 97.5 was corrected: O5 is worth two points. |
| C3 | nit | Fixed. Only selected counts are live announcements; loaded counts are static and omitted during search to avoid duplicating its result count. |
| C4 | nit | Declined. Loaded-row selection matches the existing command behavior; the count and tooltip describe its scope. No broader selection behavior is introduced. |
| C5 | nit | Fixed. The global xs token is restored to 11px; only sidebar and settings section headings use the 12px token. |
| C6 | nit | Fixed. Slider endpoint labels explicitly say Show after / Show before. |
| C7 | nit | Fixed. The score's own label now says on rubric v1, next to the hero score. |
| C8 | nit | Fixed for the current after evidence. All six after screenshots were recaptured with toasts dismissed, focus cleared, and animations settled. Original before evidence is preserved unchanged. |

Tracked scoped diff before review: 18 files, 199 insertions, 50 deletions. Before round 2: 17 files, 195 insertions, 20 deletions (including the added disabled-color paths). These counts exclude untracked settings and report artifacts.

Validation after fixes: typecheck, lint including token guard, production build, and all 584 tests pass. The two theme-ordering regression cases replaced the now-unnecessary Calendar-checkpoint migration test, for a net increase of one test. Existing React virtualization/mock Tauri warnings remain.

The corrected 98/100 comparison is approved for publication at the existing URL. Application changes remain in the working checkout; the comparison is published through the share-html workflow. Model usage and effort remain unavailable.

Publication completed: share commit `f7c9dad21a056e236ad5cc82b4a6f09f822b8d28`,
[successful deployment](https://github.com/AlexGenovezos/share/actions/runs/41963753505).
The live page and screenshot assets remain behind the existing GitHub sign-in
gate (unauthenticated HTTP 302). Source HTML and all twelve screenshots were
verified byte-identical between the local artifact and published checkout.
The app itself was not committed or released by this UI review.
