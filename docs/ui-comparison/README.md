# Pheeme UI comparison

Published with the `share-html` skill:

https://share.genovezos.dev/volunteer-manager/pheeme-ui-refresh

The comparison and its images are behind the existing GitHub sign-in gate. The
share repository deployment succeeded for commit
`c9a45ddb24d6fea4fc9b12b893d2247ab5255096`; unauthenticated requests to both the
page and an image returned the expected HTTP 302.

- `index.html`: interactive comparison website, with six screenshot pairs and
  all 40 original scoring conditions and their evidence.
- `pheeme-ui-refresh-assets/`: screenshots captured before and after
  the app changes. The Small window scene was captured at a 900×600 CSS viewport;
  the original before capture was scaled independently of CSS size.
- `score.json`: baseline and after results under rubric v1. Weights and pass
  conditions are copied from the original scorecard without modification.

The baseline remains in `../ui-scorecard.md`. The new assessment is in
`../ui-scorecard-after.md`. Application changes remain in the Pheeme working
checkout; publishing the comparison does not release a desktop build.

Claude Opus 5.5 approved the corrections after two review rounds. The final
score is 98/100 under the unchanged rubric; Calendar preparation is retained
and O5 remains a two-point deduction. The earlier 100/100 report is superseded.
The after-image URLs use a new query version so viewers receive the updated
captures. See `../ui-review-claude.md` for the findings and resolutions.

On 05 Nov, sender initial avatars were removed from the app at Alex’s request.
The five mail-related after screenshots were recaptured; before screenshots and
the onboarding pair are preserved. The score remains 98/100. After-image URLs
now use `?v=3` to refresh cached evidence. This follow-up passed 46 relevant
tests, typecheck, lint, a production build, and headless checkbox interaction
checks. It follows the completed Claude review.
