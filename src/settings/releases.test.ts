import { describe, expect, it } from "vitest";
import { version } from "../../package.json";
import { displayVersion } from "../lib/updater";
import { RELEASES, releasesFrom } from "./releases";

describe("releasesFrom", () => {
  const files = {
    "../../docs/releases/v0.7.md": "Seven.\n",
    "../../docs/releases/v0.10.md": "Ten.\n",
    "../../docs/releases/v0.8.md": "<!-- guide -->\nEight.\n",
    "../../docs/releases/v0.11.md": "Not out yet.\n",
  };

  it("lists releases up to the running version, newest first", () => {
    expect(releasesFrom(files, "0.10.0").map((r) => r.version)).toEqual(["0.10", "0.8", "0.7"]);
  });

  it("parses each release's notes", () => {
    expect(releasesFrom(files, "0.8.0")[0]).toEqual({
      version: "0.8",
      blocks: [{ type: "paragraph", content: [{ type: "text", text: "Eight." }] }],
    });
  });
});

it("bundles the notes for the version being built", () => {
  expect(RELEASES[0]?.version).toBe(displayVersion(version));
});
