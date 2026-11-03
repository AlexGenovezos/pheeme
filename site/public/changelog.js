// Lists pheeme's releases from GitHub, with their notes as GitHub renders them, so the page never
// needs an edit per release. The notes come from docs/releases/ in the app repo (see the release
// workflow). Without JavaScript, or if GitHub can't be reached, the page links to the releases there.
(() => {
  const REPO = "AlexGenovezos/pheeme";
  const DATE = new Intl.DateTimeFormat("en", { year: "numeric", month: "long", day: "numeric" });

  function el(tag, props = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }

  function entry(release) {
    const id = release.tag_name.replace(/[^\w.-]/g, "");
    const when = release.published_at ? DATE.format(new Date(release.published_at)) : "";
    const notes = el("div", { className: "release-notes" });
    // GitHub's rendered, sanitized HTML for the notes (requested with the html+json media type).
    if (release.body_html?.trim()) notes.innerHTML = release.body_html;
    else notes.append(el("p", { className: "changelog-status", textContent: "No notes for this release." }));
    return el("article", { className: "release", id }, [
      el("h2", {}, [el("a", { href: `#${id}`, textContent: release.name || release.tag_name })]),
      el("p", { className: "updated" }, [
        `${when}${when ? " · " : ""}`,
        el("a", { href: release.html_url, textContent: "Downloads" }),
      ]),
      notes,
    ]);
  }

  async function run() {
    const box = document.querySelector("[data-releases]");
    if (!box) return;
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=50`, {
        headers: { Accept: "application/vnd.github.html+json" },
      });
      if (!res.ok) throw new Error(String(res.status));
      const releases = (await res.json()).filter((r) => !r.draft);
      if (releases.length === 0) return;
      box.replaceChildren(...releases.map(entry));
      if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
    } catch {
      // Keep the fallback link.
    }
  }

  run();
})();
