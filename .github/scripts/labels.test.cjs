// Run with: node --test .github/scripts/labels.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ensureLabels, setExclusiveLabel } = require("./labels.cjs");

const repo = { owner: "o", repo: "r" };

function httpError(status) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

// In-memory stand-in for github.rest.issues. `labels` are repo labels by name;
// `issueLabels` are label names on the one issue. `failCreate` makes createLabel throw.
function fakeGithub({ labels = {}, issueLabels = [], failCreate, failRemove } = {}) {
  const calls = [];
  const issues = {
    async getLabel({ name }) {
      calls.push(["getLabel", name]);
      if (!labels[name]) throw httpError(404);
      return { data: labels[name] };
    },
    async createLabel({ name, color, description }) {
      calls.push(["createLabel", name]);
      if (failCreate) throw failCreate;
      labels[name] = { name, color, description };
    },
    async updateLabel({ name, color, description }) {
      calls.push(["updateLabel", name]);
      labels[name] = { name, color, description };
    },
    async listLabelsOnIssue() {
      calls.push(["listLabelsOnIssue"]);
      return { data: issueLabels.map((name) => ({ name })) };
    },
    async removeLabel({ name }) {
      calls.push(["removeLabel", name]);
      if (failRemove) throw failRemove;
      issueLabels = issueLabels.filter((l) => l !== name);
    },
    async addLabels({ labels: added }) {
      calls.push(["addLabels", ...added]);
      issueLabels = [...issueLabels, ...added];
    },
  };
  return { github: { rest: { issues } }, calls, labels, issueLabels: () => issueLabels };
}

const bug = { name: "bug", color: "d73a4a", description: "Broken." };

test("creates a missing label", async () => {
  const fake = fakeGithub();
  await ensureLabels(fake.github, repo, [bug]);
  assert.deepEqual(fake.labels.bug, bug);
  assert.deepEqual(fake.calls, [
    ["getLabel", "bug"],
    ["createLabel", "bug"],
  ]);
});

test("tolerates a concurrent create (422 already_exists)", async () => {
  const fake = fakeGithub({ failCreate: httpError(422) });
  await ensureLabels(fake.github, repo, [bug]);
  assert.deepEqual(fake.calls, [
    ["getLabel", "bug"],
    ["createLabel", "bug"],
  ]);
});

test("rethrows other create errors", async () => {
  const fake = fakeGithub({ failCreate: httpError(500) });
  await assert.rejects(ensureLabels(fake.github, repo, [bug]), { status: 500 });
});

test("updates a label whose color or description drifted", async () => {
  for (const stale of [
    { ...bug, color: "000000" },
    { ...bug, description: null },
  ]) {
    const fake = fakeGithub({ labels: { bug: stale } });
    await ensureLabels(fake.github, repo, [bug]);
    assert.deepEqual(fake.labels.bug, bug);
    assert.deepEqual(fake.calls, [
      ["getLabel", "bug"],
      ["updateLabel", "bug"],
    ]);
  }
});

test("leaves an up-to-date label alone", async () => {
  const fake = fakeGithub({ labels: { bug: { ...bug } } });
  await ensureLabels(fake.github, repo, [bug]);
  assert.deepEqual(fake.calls, [["getLabel", "bug"]]);
});

const sizes = new Set(["size:S", "size:M", "size:L"]);

test("replaces the other managed labels and keeps unmanaged ones", async () => {
  const fake = fakeGithub({ issueLabels: ["size:S", "bug", "size:L"] });
  await setExclusiveLabel(fake.github, repo, 7, sizes, "size:M");
  assert.deepEqual(fake.issueLabels(), ["bug", "size:M"]);
});

test("does not re-add the label when it is already there", async () => {
  const fake = fakeGithub({ issueLabels: ["size:M", "size:S"] });
  await setExclusiveLabel(fake.github, repo, 7, sizes, "size:M");
  assert.deepEqual(fake.issueLabels(), ["size:M"]);
  assert.ok(!fake.calls.some(([name]) => name === "addLabels"));
});

test("ignores a label removed concurrently (404) but rethrows others", async () => {
  const gone = fakeGithub({ issueLabels: ["size:S"], failRemove: httpError(404) });
  await setExclusiveLabel(gone.github, repo, 7, sizes, "size:M");
  assert.ok(gone.calls.some(([name]) => name === "addLabels"));

  const broken = fakeGithub({ issueLabels: ["size:S"], failRemove: httpError(403) });
  await assert.rejects(setExclusiveLabel(broken.github, repo, 7, sizes, "size:M"), { status: 403 });
});
