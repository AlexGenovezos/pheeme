// The keyboard inbox demo on the home page. No dependencies.
(() => {
  const root = document.getElementById("demo");
  if (!root) return;

  const MESSAGES = [
    {
      from: "GitHub", time: "9:41", unread: true,
      subj: "Review requested: sync: batch IMAP FETCH by UID range",
      body: [
        "jules requested your review on pheeme#48.",
        "Instead of one FETCH per message, the sync loop now asks for whole UID ranges. On a 40k message mailbox the first sync drops from minutes to seconds.",
        "+212 −87 across 6 files.",
      ],
    },
    {
      from: "Maya Okafor", time: "9:12", unread: true,
      subj: "Lunch Thursday? The ramen place reopened",
      body: ["They fixed the broth. I'm told it's worth the line now.", "12:30 works for me if it works for you."],
    },
    {
      from: "Cloudflare", time: "8:57",
      subj: "Deploy succeeded: pheeme-website",
      body: ["Your Worker pheeme-website was deployed from main.", "Commit: \"Add roadmap section\"", "Live at pheeme.app."],
    },
    {
      from: "Sam Reyes", time: "8:30", unread: true,
      subj: "Re: shortcut list, a few ideas",
      body: [
        "Agree on e for done. Can we keep gi for go-to-inbox too? Muscle memory from Gmail is hard to break.",
        "Also, # for delete feels right. Nobody deletes on purpose with a single letter.",
      ],
    },
    {
      from: "Priya Natarajan", time: "Yesterday", starred: true,
      subj: "Notes from the search benchmark",
      body: [
        "Indexed 120k messages locally. Prefix search stays under 20 ms on my laptop, and full-text sits around 35 ms.",
        "Raw numbers are in the gist. Happy to pair on the tokenizer this week.",
      ],
    },
    {
      from: "Domain registrar", time: "Yesterday",
      subj: "pheeme.app renews in 30 days",
      body: ["Auto-renew is on. Nothing to do.", "We'll charge the card ending in 4242 on renewal."],
    },
    {
      from: "Theo at the meetup", time: "Mon",
      subj: "Slides from Tuesday's local-first talk",
      body: ["Thanks for coming out! Slides and the recording are linked below.", "Next month's topic is CRDTs in production."],
    },
  ].map((m, i) => ({ id: i, starred: false, unread: false, ...m }));

  const $ = (id) => document.getElementById(id);
  const list = $("list");
  const reader = $("reader");
  const hint = $("hint");
  const searchEl = $("search");
  const queryEl = $("query");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let inbox = MESSAGES.slice();
  let done = []; // stack of { msg, index }
  let sel = 0;
  let query = "";
  let searching = false;
  let busy = false;
  let autoplay = null;
  let played = false; // autoplay runs once, and never after the visitor takes over
  let visible = false;

  const view = () =>
    query
      ? inbox.filter((m) => (m.from + " " + m.subj + " " + m.body.join(" ")).toLowerCase().includes(query.toLowerCase()))
      : inbox;

  function esc(s) {
    return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }

  function render() {
    const items = view();
    sel = Math.max(0, Math.min(sel, items.length - 1));
    if (!items.length) {
      list.innerHTML = query
        ? `<li class="empty">Nothing matches “${esc(query)}”. Press <kbd>Esc</kbd> to clear the search.</li>`
        : `<li class="empty">Inbox zero. Press <kbd>z</kbd> to bring one back.</li>`;
      reader.innerHTML = "";
    } else {
      list.innerHTML = items
        .map(
          (m, i) =>
            `<li class="msg${i === sel ? " sel" : ""}${m.unread ? " unread" : ""}${m.starred ? " starred" : ""}" data-id="${m.id}"${i === sel ? ' aria-current="true"' : ""}>` +
            `<span class="from">${esc(m.from)}</span><span class="time">${esc(m.time)}</span><span class="subj">${esc(m.subj)}</span></li>`,
        )
        .join("");
      const m = items[sel];
      m.unread = false;
      list.children[sel]?.classList.remove("unread");
      reader.innerHTML =
        `<h3>${esc(m.subj)}</h3><p class="meta">${esc(m.from)}, ${esc(m.time)}</p>` +
        `<div class="body">${m.body.map((p) => `<p>${esc(p)}</p>`).join("")}</div>`;
    }
    $("count").textContent = inbox.length;
    $("starcount").textContent = MESSAGES.filter((m) => m.starred).length;
    $("donecount").textContent = done.length;
    searchEl.hidden = !searching && !query;
    queryEl.textContent = query;
    searchEl.querySelector(".caret").style.display = searching ? "" : "none";
  }

  function flash(key) {
    const b = root.querySelector(`.keys button[data-key="${CSS.escape(key)}"]`);
    if (!b) return;
    b.classList.add("hit");
    setTimeout(() => b.classList.remove("hit"), 180);
  }

  function act(key) {
    if (busy) return;
    const items = view();
    flash(key);
    switch (key) {
      case "j": sel = Math.min(sel + 1, items.length - 1); render(); break;
      case "k": sel = Math.max(sel - 1, 0); render(); break;
      case "s": {
        const m = items[sel];
        if (m) { m.starred = !m.starred; render(); }
        break;
      }
      case "e": {
        const m = items[sel];
        if (!m) break;
        const finish = () => {
          done.push({ msg: m, index: inbox.indexOf(m) });
          inbox = inbox.filter((x) => x !== m);
          busy = false;
          render();
        };
        if (reduced) return finish();
        busy = true;
        list.children[sel].classList.add("leaving");
        setTimeout(finish, 280);
        break;
      }
      case "z": {
        const last = done.pop();
        if (!last) break;
        inbox.splice(last.index, 0, last.msg);
        query = "";
        sel = last.index;
        render();
        break;
      }
      case "/": searching = true; render(); break;
    }
  }

  function setHint(text) { hint.textContent = text; }

  function stopAutoplay() {
    played = true;
    if (!autoplay) return;
    autoplay.forEach(clearTimeout);
    autoplay = null;
    setHint("Your turn. Press j, k, e, or / to search.");
  }

  function startAutoplay() {
    if (reduced || played) return;
    played = true;
    const steps = ["j", "j", "k", "s", "e", "e"];
    autoplay = [];
    setHint("Watch, then take over with your keyboard.");
    steps.forEach((k, i) => autoplay.push(setTimeout(() => act(k), 700 + i * 650)));
    autoplay.push(setTimeout(stopAutoplay, 700 + steps.length * 650 + 300));
  }

  const keyHandled = new Set(["j", "k", "e", "s", "z", "/"]);

  document.addEventListener("keydown", (ev) => {
    if (!visible && document.activeElement !== root) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const t = ev.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;

    if (searching) {
      if (ev.key === "Escape") { searching = false; query = ""; }
      else if (ev.key === "Enter") { searching = false; sel = 0; }
      else if (ev.key === "Backspace") { query = query.slice(0, -1); sel = 0; }
      else if (ev.key.length === 1) { query += ev.key; sel = 0; }
      else return;
      ev.preventDefault();
      stopAutoplay();
      render();
      return;
    }
    if (ev.key === "Escape" && query) { query = ""; render(); ev.preventDefault(); return; }
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      if (document.activeElement !== root) return; // leave page scrolling alone
      ev.preventDefault();
      stopAutoplay();
      act(ev.key === "ArrowDown" ? "j" : "k");
      return;
    }
    if (!keyHandled.has(ev.key)) return;
    ev.preventDefault();
    stopAutoplay();
    act(ev.key);
  });

  root.querySelectorAll(".keys button").forEach((b) =>
    b.addEventListener("click", () => {
      stopAutoplay();
      act(b.dataset.key);
      if (b.dataset.key === "/") setHint("Type to search. Enter keeps the results, Esc clears them.");
    }),
  );

  list.addEventListener("click", (ev) => {
    const li = ev.target.closest(".msg");
    if (!li) return;
    stopAutoplay();
    sel = [...list.children].indexOf(li);
    render();
  });

  new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting;
      if (visible) startAutoplay();
    },
    { threshold: 0.6 },
  ).observe(root);

  render();
})();
