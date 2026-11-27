// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildUpdaterJson } from "./updater-json.mjs";

// As `gh api …/releases/{id}/assets` lists them while the release is still a draft.
const asset = (name, id) => ({
  name,
  url: `https://api.github.com/repos/o/r/releases/assets/${id}`,
  browser_download_url: `https://github.com/o/r/releases/download/untagged-1a2b3c/${name}`,
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
/** The public link to the `id`th asset of `list`, under the tag the release is published with. */
const url = (id, list = assets, tag = "v0.4") =>
  `https://github.com/o/r/releases/download/${tag}/${list[id - 1].name}`;

describe("buildUpdaterJson", () => {
  const json = buildUpdaterJson({
    version: "0.4.0",
    tag: "v0.4",
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

  it("uses the msi, when there is one, and the AppImage as the primary Windows and Linux updaters", () => {
    expect(json.platforms["windows-x86_64"].url).toBe(url(6));
    expect(json.platforms["windows-x86_64-nsis"].url).toBe(url(4));
    expect(json.platforms["linux-x86_64"].url).toBe(url(8));
  });

  it("serves each mac arch its own bundle and Windows the NSIS exe (v0.8 on)", () => {
    const split = [
      asset("Pheeme_0.8.0_aarch64.app.tar.gz", 1),
      asset("Pheeme_0.8.0_aarch64.app.tar.gz.sig", 2),
      asset("Pheeme_0.8.0_x64.app.tar.gz", 3),
      asset("Pheeme_0.8.0_x64.app.tar.gz.sig", 4),
      asset("Pheeme_0.8.0_aarch64.dmg", 5),
      asset("Pheeme_0.8.0_x64.dmg", 6),
      asset("Pheeme_0.8.0_x64-setup.exe", 7),
      asset("Pheeme_0.8.0_x64-setup.exe.sig", 8),
      asset("Pheeme_0.8.0_amd64.AppImage", 9),
      asset("Pheeme_0.8.0_amd64.AppImage.sig", 10),
    ];
    const sigs = Object.fromEntries(
      split.filter((a) => a.name.endsWith(".sig")).map((a) => [a.name.slice(0, -4), "s"]),
    );
    const { platforms } = buildUpdaterJson({
      version: "0.8.0",
      tag: "v0.8",
      assets: split,
      signatures: sigs,
      pubDate: "now",
    });
    expect(platforms["darwin-aarch64"].url).toBe(url(1, split, "v0.8"));
    expect(platforms["darwin-aarch64-app"].url).toBe(url(1, split, "v0.8"));
    expect(platforms["darwin-x86_64"].url).toBe(url(3, split, "v0.8"));
    expect(platforms["darwin-x86_64-app"].url).toBe(url(3, split, "v0.8"));
    expect(platforms["darwin-universal"]).toBeUndefined();
    expect(platforms["windows-x86_64"].url).toBe(url(7, split, "v0.8"));
    expect(platforms["windows-x86_64-nsis"].url).toBe(url(7, split, "v0.8"));
    expect(platforms["windows-x86_64-msi"]).toBeUndefined();
  });

  it("links the public download, not GitHub's rate-limited API, under the release's tag", () => {
    for (const { url: link } of Object.values(json.platforms)) {
      expect(link).toMatch(/^https:\/\/github\.com\/o\/r\/releases\/download\/v0\.4\//);
    }
    const published = { ...assets[0], browser_download_url: url(1) };
    const { platforms } = buildUpdaterJson({
      version: "0.4.0",
      assets: [published],
      signatures,
      pubDate: "now",
    });
    expect(platforms["darwin-aarch64"].url).toBe(url(1));
    expect(() =>
      buildUpdaterJson({ version: "0.4.0", assets: [assets[0]], signatures, pubDate: "now" }),
    ).toThrow(/tag is needed/);
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
