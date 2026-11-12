// window.stage: what scenes.mjs calls to move the camera, show words and
// draw the cursor and keys. Every call returns at once; the director waits.
(() => {
  const $ = (s) => document.querySelector(s);
  const body = document.body;
  const camera = $(".camera");
  const win = $(".app-window");
  const headline = $(".headline");
  const note = $(".note");
  const keys = $(".keys");
  const cursor = $(".pointer");
  const ripple = $(".ripple");
  const card = $(".card");

  const APP_W = 1440;
  const APP_H = 810;
  const STAGE_W = 1920;
  const STAGE_H = 1080;

  // Named camera positions. Rotations are in degrees, y in stage pixels.
  const SHOTS = {
    below: { scale: 0.86, y: 1150, rx: 60 },
    tilt: { scale: 0.98, y: 150, rx: 30 },
    wide: { scale: 1, y: 0, rx: 0 },
    back: { scale: 0.84, y: 40, rx: 0 },
  };

  let cursorAt = { x: STAGE_W / 2, y: STAGE_H + 60 };

  function setCamera({ scale = 1, x = 0, y = 0, rx = 0, ry = 0 }, ms) {
    camera.style.setProperty("--move", `${ms}ms`);
    camera.style.transform =
      `translate3d(${x}px, ${y}px, 0) rotateX(${rx}deg) rotateY(${ry}deg) scale(${scale})`;
  }

  /** The camera filling the frame with a part of the app (app pixels). */
  function focusOn(rect, { pad = 60, max = 2.2, dy = 30 } = {}) {
    const scale = Math.max(
      0.5,
      Math.min(max, (STAGE_W - pad * 2) / rect.width, (STAGE_H - pad * 2 - 120) / rect.height),
    );
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    // Scaling happens around the window's centre, which sits at the stage's centre.
    return { scale, x: -scale * (cx - APP_W / 2), y: -scale * (cy - APP_H / 2) + dy };
  }

  /** Where a point in the app is on the stage, for a camera with no rotation. */
  function toStage(x, y) {
    const r = win.getBoundingClientRect();
    const s = r.width / APP_W;
    return { x: r.left + x * s, y: r.top + y * s };
  }

  let keysTimer = 0;

  window.stage = {
    shot(name, ms = 1200) {
      setCamera(SHOTS[name], ms);
    },
    focus(rect, opts = {}, ms = 1200) {
      setCamera(focusOn(rect, opts), ms);
    },
    blur(on) {
      body.classList.toggle("blur", on);
    },
    fade(on) {
      body.classList.toggle("fade", on);
    },
    headline(title, text = "", { top = false } = {}) {
      headline.classList.toggle("headline--top", top);
      const t = headline.querySelector(".headline__title");
      t.innerHTML = title
        .split(" ")
        .map((w, i) => `<span class="w" style="--i:${i}">${w}</span>`)
        .join(" ");
      headline.querySelector(".headline__body").innerHTML = text;
      // One gradient across the whole line: each word shows its own slice of it.
      const left = t.getBoundingClientRect().left;
      for (const w of t.querySelectorAll(".w")) {
        w.style.setProperty("--x", String(w.getBoundingClientRect().left - left));
      }
      headline.classList.remove("leave");
      void headline.offsetWidth;
      headline.classList.add("on");
    },
    headlineOut() {
      headline.classList.add("leave");
      headline.classList.remove("on");
    },
    note(html) {
      if (!html) {
        note.classList.remove("on");
        return;
      }
      note.innerHTML = html;
      note.classList.add("on");
    },
    keys(labels, hold = 900) {
      clearTimeout(keysTimer);
      keys.classList.remove("fade");
      keys.innerHTML = labels.map((k) => `<kbd class="down">${k}</kbd>`).join("");
      setTimeout(() => keys.querySelectorAll("kbd").forEach((k) => k.classList.remove("down")), 140);
      keysTimer = setTimeout(() => keys.classList.add("fade"), hold);
    },
    cursor(x, y, ms = 700, { app = true } = {}) {
      const p = app ? toStage(x, y) : { x, y };
      cursorAt = p;
      cursor.style.setProperty("--glide", `${ms}ms`);
      cursor.classList.add("on");
      cursor.style.translate = `${p.x}px ${p.y}px`;
    },
    hideCursor() {
      cursor.classList.remove("on");
    },
    click() {
      cursor.classList.add("press");
      setTimeout(() => cursor.classList.remove("press"), 140);
      ripple.style.left = `${cursorAt.x}px`;
      ripple.style.top = `${cursorAt.y}px`;
      ripple.classList.remove("go");
      void ripple.offsetWidth;
      ripple.classList.add("go");
    },
    card({ title = "", text = "", cta = "" } = {}) {
      card.querySelector(".card__title").textContent = title;
      card.querySelector(".card__body").textContent = text;
      card.querySelector(".card__cta").textContent = cta;
      card.classList.add("on");
    },
    cardOut() {
      card.classList.remove("on");
    },
  };

  // Start off-screen under the horizon, under the title card.
  setCamera(SHOTS.below, 0);
  // The pointer first glides in from below the frame, not from its corner.
  cursor.style.translate = `${cursorAt.x}px ${cursorAt.y}px`;
})();
