// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildUpdaterJson } from "./updater-json.mjs";

const asset = (name, id) => ({
  name,
  url: `https://api.github.com/repos/o/r/releases/assets/${id}`,
});

// The v0.4 release's assets.
const assets = [
  asset("Pheeme_0.4.0_universal.app.tar.gz", 1),
  asset("Pheeme_0.4.0_universal.app.tar.gz.sig", 2),
  asset("Pheeme_0.4.0_universal.dmg", 3),
  asset("Pheeme_0.4.0_x64-setup.exe", 4),
  asset("Pheeme_0.4.0_x64-setup.exe.sig", 5),
  asset("Pheeme_0.4.0_x64_en-US.msi", 6),
  asset("Pheeme_0.4.0_x64_en-US.msi.sig", 7),
  asset("Pheeme_0.4.0_amd64.AppImage", 8),
  asset("Pheeme_0.4.0_amd64.AppImage.sig", 9),
  asset("Pheeme_0.4.0_amd64.deb", 10),
  asset("Pheeme_0.4.0_amd64.deb.sig", 11),
];
const signatures = Object.fromEntries(
  assets.filter((a) => a.name.endsWith(".sig")).map((a) => [a.name.slice(0, -4), `sig-${a.name}`]),
);
const url = (id) => `https://api.github.com/repos/o/r/releases/assets/${id}`;

describe("buildUpdaterJson", () => {
  const json = buildUpdaterJson({
    version: "0.4.0",
    assets,
    signatures,
    pubDate: "now",
  });

  it("writes the same platform keys as tauri-action", () => {
    expect(Object.keys(json.platforms).sort()).toEqual(
      [
        "darwin-aarch64",
        "darwin-aarch64-app",
        "darwin-universal",
        "darwin-universal-app",
        "darwin-x86_64",
        "darwin-x86_64-app",
        "linux-x86_64",
        "linux-x86_64-appimage",
        "linux-x86_64-deb",
        "windows-x86_64",
        "windows-x86_64-msi",
        "windows-x86_64-nsis",
      ].sort(),
    );
    expect(json).toMatchObject({
      version: "0.4.0",
      notes: "",
      pub_date: "now",
    });
  });

  it("serves both mac arches from the universal bundle", () => {
    expect(json.platforms["darwin-aarch64"]).toEqual({
      url: url(1),
      signature: "sig-Pheeme_0.4.0_universal.app.tar.gz.sig",
    });
    expect(json.platforms["darwin-x86_64"].url).toBe(url(1));
  });

  it("uses the msi and the AppImage as the primary Windows and Linux updaters", () => {
    expect(json.platforms["windows-x86_64"].url).toBe(url(6));
    expect(json.platforms["windows-x86_64-nsis"].url).toBe(url(4));
    expect(json.platforms["linux-x86_64"].url).toBe(url(8));
  });

  it("fails on a signed asset it has no platform for", () => {
    expect(() =>
      buildUpdaterJson({
        version: "0.4.0",
        assets: [asset("Pheeme_0.4.0_x86_64.rpm", 1)],
        signatures: { "Pheeme_0.4.0_x86_64.rpm": "s" },
        pubDate: "now",
      }),
    ).toThrow(/no updater platform/);
  });
});
