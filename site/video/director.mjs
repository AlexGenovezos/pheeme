// The verbs scenes.mjs is written in. Each one moves the stage (stage.js) or
// drives the real demo app inside it, and waits for the move to finish so a
// storyboard reads top to bottom like a shot list.
//
// Time is the recording's, not the wall clock's: every wait films frames
// (record.mjs steps the page's clock and animations a frame at a time), and
// actions happen between two frames.

const KEY_LABELS = { Meta: "⌘", Control: "Ctrl", Shift: "⇧", Alt: "⌥", Enter: "return", Escape: "esc", Slash: "/" };

export class Director {
  /**
   * @param {import("playwright").Page} page the stage
   * @param {import("playwright").Frame} app the demo app inside it
   * @param {{ now(): number, advance(ms: number): Promise<void>, frame: number }} film
   *   films `ms` of video; `now()` is the time into the video
   */
  constructor(page, app, film) {
    this.page = page;
    this.app = app;
    this.film = film;
    this.chapters = [];
    this.poster = null;
  }

  /** Locators inside the app, e.g. `d.$.getByRole("listbox")`. */
  get $() {
    return this.app;
  }

  /** Films `ms` of whatever is on the stage. */
  wait(ms) {
    return this.film.advance(ms);
  }

  /**
   * Films until an app element shows, or fails the recording: a step the app
   * no longer supports must not film nothing happening.
   */
  async until(locator, what = "An element the storyboard needs", ms = 5000) {
    for (const end = this.film.now() + ms; !(await locator.isVisible()); ) {
      if (this.film.now() >= end) throw new Error(`${what} didn't appear within ${ms} ms.`);
      await this.film.advance(this.film.frame);
    }
  }

  /** Marks where a part of the video starts, for the description track. */
  chapter(text) {
    this.chapters.push({ at: this.film.now(), text });
  }

  stage(method, ...args) {
    return this.page.evaluate(([m, a]) => window.stage[m](...a), [method, args]);
  }

  /** A named camera position from stage.js: below, tilt, wide, back. */
  async shot(name, ms = 1200) {
    await this.stage("shot", name, ms);
    await this.wait(ms);
  }

  /** Where one or more app elements are, in app pixels, as one box. */
  async rectOf(...targets) {
    const rects = [];
    for (const t of targets) {
      if (!("evaluate" in t)) {
        rects.push(t);
        continue;
      }
      await this.until(t);
      rects.push(
        await t.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }),
      );
    }
    const x = Math.min(...rects.map((r) => r.x));
    const y = Math.min(...rects.map((r) => r.y));
    const right = Math.max(...rects.map((r) => r.x + r.width));
    const bottom = Math.max(...rects.map((r) => r.y + r.height));
    return { x, y, width: right - x, height: bottom - y };
  }

  /**
   * Zooms the camera onto app elements (locators or `{x, y, width, height}`
   * boxes in app pixels). `max` caps the zoom; `margin` (app pixels) widens
   * the shot around the target.
   */
  async focus(targets, { max = 2.2, pad = 60, dy = 30, ms = 1200, margin = 0 } = {}) {
    const list = Array.isArray(targets) ? targets : [targets];
    const r = await this.rectOf(...list);
    // `margin` keeps some of the app around the target in the shot.
    const rect = { x: r.x - margin, y: r.y - margin, width: r.width + margin * 2, height: r.height + margin * 2 };
    await this.stage("focus", rect, { max, pad, dy }, ms);
    await this.wait(ms);
  }

  /** Big words over the blurred app, then back to the app. */
  async headline(title, text = "", { hold = 2300 } = {}) {
    await this.stage("blur", true);
    await this.wait(250);
    await this.stage("headline", title, text);
    await this.wait(hold);
    await this.stage("headlineOut");
    await this.wait(250);
    await this.stage("blur", false);
    await this.wait(500);
  }

  /** A short line pinned to the top of the frame during a shot. Empty hides it. */
  async note(html = "", ms = 0) {
    await this.stage("note", html);
    if (ms) await this.wait(ms);
  }

  /** Presses a key combination in the app and shows it as keycaps. */
  async press(combo, { hold = 700, label } = {}) {
    const caps = label ?? combo.split("+").map((k) => KEY_LABELS[k] ?? k.toUpperCase());
    await this.stage("keys", caps, hold);
    await this.page.keyboard.press(combo);
    await this.wait(hold);
  }

  /** Types into whatever has focus in the app, a key at a time. */
  async type(text, { delay = 65 } = {}) {
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      await this.wait(delay);
    }
  }

  /** Glides the cursor onto an app element and clicks it. */
  async click(target, { glide = 650, settle = 180 } = {}) {
    const r = await this.rectOf(target);
    await this.stage("cursor", r.x + r.width / 2, r.y + r.height / 2, glide);
    await this.wait(glide + settle);
    await this.stage("click");
    await target.click();
    await this.wait(250);
  }

  hideCursor() {
    return this.stage("hideCursor");
  }

  async card(content, { hold = 3000 } = {}) {
    await this.stage("card", content);
    await this.wait(hold);
  }

  async cardOut(ms = 700) {
    await this.stage("cardOut");
    await this.wait(ms);
  }

  /** Uses this moment as the video's poster image. */
  async takePoster() {
    this.poster = await this.page.screenshot({ type: "jpeg", quality: 88, scale: "css" });
  }
}
