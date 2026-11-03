// Scroll-linked scenes and reveal-on-enter, in the spirit of Apple's product pages.
// Only runs when <html> has .motion (set in <head> unless reduced motion is on).
(() => {
  const root = document.documentElement;
  if (!root.classList.contains("motion")) return;

  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const range = (p, a, b) => clamp((p - a) / (b - a)); // map p in [a,b] to [0,1]
  const ease = (t) => 1 - Math.pow(1 - t, 3); // ease-out cubic
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  // ---- reveal on enter ----
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -12% 0px", threshold: 0.15 },
  );
  document.querySelectorAll("[data-reveal]").forEach((el) => io.observe(el));

  // ---- split the statement into words ----
  document.querySelectorAll("[data-words]").forEach((el) => {
    const words = el.textContent.trim().split(/\s+/);
    el.setAttribute("aria-label", el.textContent.trim());
    el.style.setProperty("--n", words.length);
    el.innerHTML = words.map((w, i) => `<span class="w" style="--i:${i}" aria-hidden="true">${w}</span>`).join(" ");
  });

  // ---- scenes ----
  const SCENES = {
    inbox(el, p, enter) {
      // starts while the section is still coming up from below the fold
      el.style.setProperty("--t", ease(range(enter, 0.12, 0.34)).toFixed(4));
      const e = ease(range(enter, 0.08, 0.58));
      el.style.setProperty("--e", e.toFixed(4));
      if (e >= 0.999 && !el.dataset.landed) {
        el.dataset.landed = "1";
        document.dispatchEvent(new CustomEvent("pheeme:demo-ready"));
      }
    },
    words(el, p) {
      el.style.setProperty("--p", range(p, 0.05, 0.8).toFixed(4));
    },
    pheme(el, p) {
      // zoom in over the first 60%, hold, then ease back out at the very end
      const zin = easeInOut(range(p, 0.05, 0.6));
      const zout = easeInOut(range(p, 0.9, 1));
      el.style.setProperty("--z", (1 + 1.25 * zin * (1 - zout)).toFixed(4));
      // three captions, each fades in, holds, and hands off to the next
      el.querySelectorAll("[data-cap]").forEach((cap) => {
        const i = Number(cap.dataset.cap);
        const start = 0.04 + i * 0.3;
        const fadeIn = range(p, start, start + 0.08);
        const fadeOut = i === 2 ? 0 : range(p, start + 0.24, start + 0.3);
        cap.style.setProperty("--o", (ease(fadeIn) * (1 - fadeOut)).toFixed(4));
      });
    },
  };

  const scenes = [...document.querySelectorAll("[data-scene]")].filter((el) => SCENES[el.dataset.scene]);

  let ticking = false;
  function update() {
    ticking = false;
    const vh = window.innerHeight;
    for (const el of scenes) {
      const r = el.getBoundingClientRect();
      if (r.bottom < -vh || r.top > 2 * vh) continue; // far offscreen
      const track = r.height - vh;
      const p = track > 0 ? clamp(-r.top / track) : 1; // 0..1 while pinned
      const enter = clamp((vh - r.top) / (vh + track)); // 0 when it peeks in, 1 when it unpins
      SCENES[el.dataset.scene](el, p, enter);
    }
  }
  const onScroll = () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(update);
    }
  };
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onScroll);
  update();
})();
