import { describe, expect, it } from "vitest";
import { version } from "../../package.json";
import { displayVersion } from "../lib/updater";
import { RELEASES, releaseDates, releasesFrom } from "./releases";

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
      date: null,
      blocks: [{ type: "paragraph", content: [{ type: "text", text: "Eight." }] }],
    });
  });

  it("dates each release from the recorded dates", () => {
    const dated = releasesFrom(files, "0.10.0", { "0.10": "2026-11-04T06:28:58Z" });
    expect(dated.map((r) => r.date)).toEqual(["2026-11-04T06:28:58Z", null, null]);
  });
});

describe("releaseDates", () => {
  const recorded = { "0.9": "2026-11-04T03:42:45Z" };

  it("dates the version being built with when its tag was pushed", () => {
    expect(releaseDates(recorded, "0.10.0", "2026-11-27T00:01:00Z")).toEqual({
      ...recorded,
      "0.10": "2026-11-27T00:01:00Z",
    });
  });

  it("keeps a recorded date, and adds nothing outside a release build", () => {
    expect(releaseDates(recorded, "0.9.0", "2026-11-27T00:01:00Z")).toBe(recorded);
    expect(releaseDates(recorded, "0.10.0", undefined)).toBe(recorded);
  });
});

it("bundles the notes for the version being built", () => {
  expect(RELEASES[0]?.version).toBe(displayVersion(version));
});
