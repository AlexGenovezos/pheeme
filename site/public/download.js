// Points the download buttons at the right installer for this visitor's OS.
// Without JavaScript, or if GitHub can't be reached, the buttons keep their
// fallback href: the latest release page, where every installer is listed.
(() => {
  const REPO = "AlexGenovezos/pheeme";

  // Each OS lists the installers it can use, best first. Matched by filename
  // suffix, because release asset names carry the version. macOS supports Apple
  // Silicon; older releases had a compatible universal dmg.
  const PLATFORMS = {
    mac: { name: "macOS (Apple Silicon)", assets: ["_aarch64.dmg", "_universal.dmg"] },
    windows: { name: "Windows", assets: ["-setup.exe", ".msi"] },
    linux: { name: "Linux", assets: [".AppImage", ".deb"] },
  };

  function detectOS() {
    const ua = navigator.userAgent;
    // Phones and tablets have no desktop build. iPadOS reports as a Mac, so
    // touch support is the giveaway there.
    if (/Android|iPhone|iPad|iPod/i.test(ua)) return null;
    const platform = (navigator.userAgentData?.platform || navigator.platform || ua).toLowerCase();
    if (platform.includes("mac")) return navigator.maxTouchPoints > 1 ? null : "mac";
    if (platform.includes("win")) return "windows";
    if (platform.includes("linux") && !platform.includes("android")) return "linux";
    return null;
  }

  function pick(assets, suffixes) {
    for (const suffix of suffixes) {
      const asset = assets.find((a) => a.name.endsWith(suffix));
      if (asset) return asset;
    }
    return null;
  }

  async function run() {
    const buttons = document.querySelectorAll("[data-download]");
    const note = document.querySelector("[data-download-note]");
    if (!buttons.length) return;

    const os = detectOS();
    const platform = os && PLATFORMS[os];
    if (platform) {
      for (const b of buttons) b.textContent = `Download for ${platform.name}`;
    }

    let release;
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!res.ok) return;
      release = await res.json();
    } catch {
      return;
    }

    const version = release.tag_name;
    const asset = platform && pick(release.assets || [], platform.assets);
    if (asset) {
      for (const b of buttons) b.href = asset.browser_download_url;
    } else {
      for (const b of buttons) b.textContent = `Download ${version}`;
    }

    if (note) {
      const parts = [`Beta ${version} for macOS (Apple Silicon), Windows and Linux`];
      // Linux gets the AppImage by default; Debian and Ubuntu users want the .deb.
      const deb = os === "linux" && pick(release.assets || [], [".deb"]);
      if (deb) parts.push(link(".deb package", deb.browser_download_url));
      parts.push(link("All downloads", release.html_url));
      note.replaceChildren(...parts.flatMap((p, i) => (i ? [" · ", p] : [p])));
    }
  }

  function link(text, href) {
    const a = document.createElement("a");
    a.textContent = text;
    a.href = href;
    return a;
  }

  run();
})();
