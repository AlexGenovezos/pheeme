/**
 * Smooth arrow-key scrolling for the focused reading pane. `scrollBy` per keydown jumps a step on every key
 * repeat (and restarts its animation on each), so the pane animates it itself: a tap glides one step,
 * holding the key glides continuously and eases to a stop on release.
 */

import { isEditableTarget } from "../keyboard/registry";

/** Distance one tap travels, px: about two lines of body text. */
const STEP = 40;
/**
 * Glide speed once fully ramped up, px/s, and how long the ramp takes, ms. The ramp is quadratic, so a
 * quick tap adds almost nothing to its step while a held key picks up speed without a pause.
 */
const MAX_SPEED = 1300;
const RAMP = 350;
/** How quickly the position follows its target, ms: lower is snappier, higher is softer. */
const EASE = 55;

/** The direction a plain ArrowUp/ArrowDown scrolls, or 0 for any other key (or one with modifiers). */
function direction(e: KeyboardEvent): -1 | 0 | 1 {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return 0;
  if (e.key === "ArrowDown") return 1;
  if (e.key === "ArrowUp") return -1;
  return 0;
}

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

class KeyScroller {
  private dir: -1 | 1 = 1;
  private held = false;
  private pressedAt = 0;
  private pos = 0;
  private target = 0;
  private written = 0;
  private frame = 0;
  private last = 0;
  private releaseOnBlur: (() => void) | null = null;

  constructor(private readonly el: HTMLElement) {}

  press(dir: -1 | 1, e: KeyboardEvent) {
    if (reducedMotion()) {
      this.stop();
      this.el.scrollTop += dir * STEP;
      return;
    }
    if (this.held && dir === this.dir) return; // a key repeat: the glide is already running
    const running = this.frame !== 0 && dir === this.dir;
    if (!running) this.sync();
    this.dir = dir;
    this.held = true;
    this.pressedAt = performance.now();
    this.target = this.clamp((running ? this.target : this.pos) + dir * STEP);
    // A key released while the window is in the background never sends keyup.
    const view = e.view ?? window;
    this.releaseOnBlur?.();
    const onBlur = () => this.release();
    view.addEventListener("blur", onBlur);
    this.releaseOnBlur = () => view.removeEventListener("blur", onBlur);
    this.start();
  }

  release(dir?: -1 | 1) {
    if (dir !== undefined && dir !== this.dir) return;
    this.held = false;
    this.releaseOnBlur?.();
    this.releaseOnBlur = null;
  }

  stop() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.release();
  }

  private sync() {
    this.pos = this.target = this.written = this.el.scrollTop;
  }

  private clamp(top: number) {
    return Math.min(Math.max(top, 0), Math.max(this.el.scrollHeight - this.el.clientHeight, 0));
  }

  private start() {
    if (this.frame) return;
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.frame = 0;
    // Something else moved the pane (the wheel, a new thread): let it win.
    if (Math.abs(this.el.scrollTop - this.written) > 2) return this.release();
    const dt = Math.min(Math.max(now - this.last, 0), 50);
    this.last = now;
    if (this.held) {
      const speed = MAX_SPEED * Math.min((now - this.pressedAt) / RAMP, 1) ** 2;
      this.target = this.clamp(this.target + (this.dir * speed * dt) / 1000);
    }
    this.pos += (this.target - this.pos) * (1 - Math.exp(-dt / EASE));
    if (!this.held && Math.abs(this.target - this.pos) < 0.5) this.pos = this.target;
    this.el.scrollTop = this.pos;
    this.written = this.el.scrollTop;
    if (this.held || this.pos !== this.target) this.frame = requestAnimationFrame(this.tick);
  };
}

const scrollers = new WeakMap<HTMLElement, KeyScroller>();
const scrollerFor = (el: HTMLElement) => {
  let scroller = scrollers.get(el);
  if (!scroller) scrollers.set(el, (scroller = new KeyScroller(el)));
  return scroller;
};

/** Scroll `el` for a plain arrow key. Returns true (and prevents the default) when it did. */
export function handleScrollKeyDown(el: HTMLElement, e: KeyboardEvent): boolean {
  const dir = direction(e);
  if (!dir || e.defaultPrevented || isEditableTarget(e.target)) return false;
  e.preventDefault();
  scrollerFor(el).press(dir, e);
  return true;
}

/** Ends a held arrow key's glide; the pane eases to a stop. */
export function handleScrollKeyUp(el: HTMLElement, e: KeyboardEvent) {
  if (e.key === "ArrowDown") scrollers.get(el)?.release(1);
  else if (e.key === "ArrowUp") scrollers.get(el)?.release(-1);
}

/** Stops any glide on `el` at once (the pane is showing something else). */
export function stopKeyScroll(el: HTMLElement) {
  scrollers.get(el)?.stop();
}
