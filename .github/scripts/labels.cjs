// Shared GitHub label helpers for the actions/github-script workflows.
// Load with require(`${process.env.GITHUB_WORKSPACE}/.github/scripts/labels.cjs`) after a
// checkout of a trusted ref. In pull_request_target workflows that is the base branch,
// never the PR head.

// Create each label, or update its color/description when they drift. A 422 on create
// means a concurrent run created it first, which is fine.
async function ensureLabels(github, repo, labels) {
  for (const label of labels) {
    try {
      const { data: existing } = await github.rest.issues.getLabel({ ...repo, name: label.name });

      if (existing.color !== label.color || (existing.description ?? "") !== label.description) {
        await github.rest.issues.updateLabel({
          ...repo,
          name: label.name,
          color: label.color,
          description: label.description,
        });
      }
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }

      try {
        await github.rest.issues.createLabel({
          ...repo,
          name: label.name,
          color: label.color,
          description: label.description,
        });
      } catch (createError) {
        if (createError.status !== 422) {
          throw createError;
        }
      }
    }
  }
}

// Leave exactly one label from managedNames on the issue: nextName.
async function setExclusiveLabel(github, repo, issueNumber, managedNames, nextName) {
  const { data: currentLabels } = await github.rest.issues.listLabelsOnIssue({
    ...repo,
    issue_number: issueNumber,
    per_page: 100,
  });

  for (const label of currentLabels) {
    if (!managedNames.has(label.name) || label.name === nextName) {
      continue;
    }

    try {
      await github.rest.issues.removeLabel({
        ...repo,
        issue_number: issueNumber,
        name: label.name,
      });
    } catch (removeError) {
      if (removeError.status !== 404) {
        throw removeError;
      }
    }
  }

  if (!currentLabels.some((label) => label.name === nextName)) {
    await github.rest.issues.addLabels({ ...repo, issue_number: issueNumber, labels: [nextName] });
  }
}

module.exports = { ensureLabels, setExclusiveLabel };
