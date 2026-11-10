(() => {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  function parse(c) {
    if (!c || c === "none") return null;
    cx.fillStyle = "#010203";
    cx.fillStyle = c;
    const a = cx.fillStyle;
    cx.fillStyle = "#040506";
    cx.fillStyle = c;
    if (cx.fillStyle !== a) return null;
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = c;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  }
  const over = (f, b) => {
    const a = f[3];
    return [f[0] * a + b[0] * (1 - a), f[1] * a + b[1] * (1 - a), f[2] * a + b[2] * (1 - a), 1];
  };
  const mix = (x, y, o) => [
    x[0] * o + y[0] * (1 - o),
    x[1] * o + y[1] * (1 - o),
    x[2] * o + y[2] * (1 - o),
    1,
  ];
  const lum = (c) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => {
    const x = lum(a),
      y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  function effective(el) {
    const chain = [];
    for (let a = el; a; a = a.parentElement) chain.unshift(a);
    let B = [255, 255, 255, 1];
    const groups = [];
    let unknown = false;
    for (const a of chain) {
      const cs = getComputedStyle(a);
      const o = parseFloat(cs.opacity);
      if (o < 1) groups.push({ o, outside: B });
      const bg = parse(cs.backgroundColor);
      if (bg && bg[3] > 0) {
        B = over(bg, B);
        if (bg[3] === 1) unknown = false;
      }
      if (cs.backgroundImage !== "none" && !cs.backgroundImage.startsWith("url(")) unknown = true;
    }
    let T = over(parse(getComputedStyle(el).color), B);
    for (let i = groups.length - 1; i >= 0; i--) {
      T = mix(T, groups[i].outside, groups[i].o);
      B = mix(B, groups[i].outside, groups[i].o);
    }
    return { T, B, unknown };
  }
  const FONT = [11, 12, 13, 15, 16, 18, 22, 28];
  const SPACE = [1, 2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48];
  const RADII = [3, 5, 8, 12];
  function tokenColors() {
    const set = [];
    const root = document.documentElement;
    const names = new Set();
    for (let i = 0; i < root.style.length; i++)
      if (root.style[i].startsWith("--")) names.add(root.style[i]);
    for (const sh of document.styleSheets) {
      let rules;
      try {
        rules = sh.cssRules;
      } catch {
        continue;
      }
      for (const r of rules)
        if (r.selectorText && /:root|html/.test(r.selectorText))
          for (let i = 0; i < r.style.length; i++)
            if (r.style[i].startsWith("--")) names.add(r.style[i]);
    }
    const cs = getComputedStyle(root);
    for (const n of names) {
      const v = cs.getPropertyValue(n).trim();
      const p = /^(#|rgb|hsl|oklch|oklab|color\(|lab|lch|hwb|[a-z]+$)/i.test(v) ? parse(v) : null;
      if (p) set.push(p);
    }
    return set;
  }
  const near = (a, b) =>
    Math.abs(a[0] - b[0]) <= 2 &&
    Math.abs(a[1] - b[1]) <= 2 &&
    Math.abs(a[2] - b[2]) <= 2 &&
    Math.abs(a[3] - b[3]) <= 0.02;
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      el.checkVisibility({ opacityProperty: false, visibilityProperty: true }) &&
      r.bottom > 0 &&
      r.right > 0 &&
      r.top < innerHeight &&
      r.left < innerWidth
    );
  };
  const label = (el) =>
    el.className && typeof el.className === "string"
      ? "." + el.className.split(" ")[0]
      : el.tagName.toLowerCase();
  const userColored = (el, root) => {
    for (let a = el; a && a !== root.parentElement; a = a.parentElement) {
      const s = a.getAttribute && a.getAttribute("style");
      if (s && /color|background|--/.test(s)) return true;
    }
    return false;
  };
  const hitBox = (el, r) => {
    if (!el.matches("input,select,textarea")) return r;
    const w = el.parentElement && el.parentElement.closest('label, .ui-input, [class*="field"]');
    if (w && w.querySelectorAll("input,select,textarea").length === 1) {
      const b = w.getBoundingClientRect();
      if (b.width >= r.width && b.height >= r.height) return b;
    }
    return r;
  };
  window.__score = (roots, opts = {}) => {
    roots = (Array.isArray(roots) ? roots : [roots])
      .flatMap((r) => (typeof r === "string" ? [...document.querySelectorAll(r)] : [r]))
      .filter(Boolean);
    const tokens = tokenColors();
    const out = {
      text: 0,
      clipped: [],
      contrastN: 0,
      contrastFail: [],
      sizes: {},
      offSize: [],
      spaceN: 0,
      spaceOff: [],
      radN: 0,
      radOff: [],
      colN: 0,
      colOff: [],
      hitN: 0,
      hitSmall: [],
      native: [],
      ctlN: 0,
      ctlOff: [],
      borders: {},
    };
    const content =
      opts.content ||
      ".cal-event,.task-chip,.cal-mini__day,.thread-row,.mini-month button,.task-row__main";
    const seen = new Set();
    const defects = [];
    for (const root of roots) {
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n; (n = tw.nextNode());) {
        const t = n.nodeValue.trim();
        const p = n.parentElement;
        if (!t || !p || !vis(p)) continue;
        if (p.closest('svg,script,style,[aria-hidden="true"]')) continue;
        const rg = document.createRange();
        rg.selectNodeContents(n);
        const r = rg.getBoundingClientRect();
        if (!r.width) continue;
        let scrolledAway = false,
          clipped = false;
        for (let a = p; a && a !== document.documentElement; a = a.parentElement) {
          const cs = getComputedStyle(a);
          const ox = cs.overflowX,
            oy = cs.overflowY;
          if (ox === "visible" && oy === "visible") continue;
          const b = a.getBoundingClientRect();
          const scroll = /auto|scroll/;
          const outX = r.left < b.left - 1 || r.right > b.right + 1,
            outY = r.top < b.top - 1 || r.bottom > b.bottom + 1;
          if ((outX && scroll.test(ox)) || (outY && scroll.test(oy))) {
            scrolledAway = true;
            break;
          }
          if (
            (outX && !scroll.test(ox) && ox !== "visible") ||
            (outY && !scroll.test(oy) && oy !== "visible")
          )
            clipped = true;
        }
        if (scrolledAway) continue;
        out.text++;
        const cs = getComputedStyle(p);
        if (clipped) {
          out.clipped.push(t.slice(0, 40));
          // How many characters still show: the visible box, less an ellipsis, in average glyph widths.
          let L = r.left,
            R = r.right;
          for (let a = p; a && a !== document.documentElement; a = a.parentElement) {
            const c2 = getComputedStyle(a);
            if (c2.overflowX !== "visible") {
              const b = a.getBoundingClientRect();
              L = Math.max(L, b.left + parseFloat(c2.paddingLeft));
              R = Math.min(R, b.right - parseFloat(c2.paddingRight));
            }
          }
          const em = parseFloat(cs.fontSize);
          const chars = Math.floor(
            (R - L - (cs.textOverflow === "ellipsis" ? 0.6 * em : 0)) / (0.55 * em),
          );
          if (t.length > 3 && chars < 3)
            defects.push("cut to " + Math.max(0, chars) + ' characters: "' + t.slice(0, 24) + '"');
        }
        const fs = Math.round(parseFloat(cs.fontSize) * 10) / 10;
        out.sizes[fs] = (out.sizes[fs] || 0) + 1;
        if (!FONT.includes(fs)) out.offSize.push(fs + 'px "' + t.slice(0, 20) + '"');
        if (!p.closest('[disabled],[aria-disabled="true"]')) {
          const e = effective(p);
          if (!e.unknown) {
            out.contrastN++;
            const big = fs >= 24 || (fs >= 18.66 && +cs.fontWeight >= 700);
            const need = big ? 3 : 4.5;
            const cr = ratio(e.T, e.B);
            if (cr < need) out.contrastFail.push(cr.toFixed(2) + ' "' + t.slice(0, 24) + '"');
          }
        }
      }
      for (const el of [root, ...root.querySelectorAll("*")]) {
        if (seen.has(el) || !vis(el) || el.closest("svg")) continue;
        seen.add(el);
        const cs = getComputedStyle(el);
        for (const k of [
          "paddingTop",
          "paddingRight",
          "paddingBottom",
          "paddingLeft",
          "rowGap",
          "columnGap",
        ]) {
          const v = parseFloat(cs[k]);
          if (!v || v < 0 || (k.endsWith("Gap") && !/flex|grid/.test(cs.display))) continue;
          out.spaceN++;
          if (!SPACE.includes(Math.round(v * 100) / 100))
            out.spaceOff.push(label(el) + " " + k + "=" + v);
        }
        const r = el.getBoundingClientRect();
        const radii = new Set(
          [
            "borderTopLeftRadius",
            "borderTopRightRadius",
            "borderBottomLeftRadius",
            "borderBottomRightRadius",
          ].map((k) => cs[k]),
        );
        for (const v of radii) {
          if (!v || v === "0px") continue;
          out.radN++;
          const px = parseFloat(v);
          if (
            !(v.includes("%") || px >= Math.min(r.width, r.height) / 2 - 0.5 || RADII.includes(px))
          )
            out.radOff.push(label(el) + " " + v);
        }
        if (!userColored(el, root)) {
          const cols = [];
          const bg = parse(cs.backgroundColor);
          if (bg && bg[3] > 0) cols.push(["bg", bg]);
          if ([...el.childNodes].some((c) => c.nodeType === 3 && c.nodeValue.trim()))
            cols.push(["text", parse(cs.color)]);
          for (const s of ["Top", "Right", "Bottom", "Left"])
            if (
              parseFloat(cs["border" + s + "Width"]) > 0 &&
              cs["border" + s + "Style"] !== "none"
            ) {
              const c = parse(cs["border" + s + "Color"]);
              if (c && c[3] > 0) {
                cols.push(["border", c]);
                break;
              }
            }
          for (const [kind, c] of cols) {
            if (!c) continue;
            out.colN++;
            if (!tokens.some((t) => near(t, c)))
              out.colOff.push(
                label(el) +
                  " " +
                  kind +
                  " rgba(" +
                  c.map((x, i) => (i < 3 ? Math.round(x) : x.toFixed(2))).join(",") +
                  ")",
              );
          }
        }
        const interactive = el.matches(
          "button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=checkbox],[role=menuitem],[role=tab],[role=option],[role=switch],[role=radio]",
        );
        if (interactive) {
          const box = hitBox(el, r);
          out.hitN++;
          if (box.width < 24 - 0.5 || box.height < 24 - 0.5)
            out.hitSmall.push(
              label(el) +
                " " +
                Math.round(box.width) +
                "x" +
                Math.round(box.height) +
                ' "' +
                (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 18) +
                '"',
            );
        }
        if (
          el.matches(
            "button,input:not([type=checkbox]):not([type=radio]):not([type=hidden]),select,[role=button]",
          ) &&
          !el.closest(content) &&
          (el.matches("input,select") || (el.textContent || "").trim())
        ) {
          out.ctlN++;
          const h = Math.round(hitBox(el, r).height * 2) / 2;
          if (![24, 28, 32].includes(h))
            out.ctlOff.push(
              label(el) +
                " h=" +
                h +
                ' "' +
                (el.getAttribute("aria-label") || el.textContent || el.value || "")
                  .trim()
                  .slice(0, 18) +
                '"',
            );
        }
        if (!el.closest(content) && !userColored(el, root))
          for (const sd of ["Top", "Right", "Bottom", "Left"]) {
            const w = parseFloat(cs["border" + sd + "Width"]);
            if (w > 0 && cs["border" + sd + "Style"] !== "none") {
              const c = parse(cs["border" + sd + "Color"]);
              if (c && c[3] > 0) {
                const key =
                  w +
                  "px " +
                  cs["border" + sd + "Style"] +
                  " rgba(" +
                  c.map((x, i) => (i < 3 ? Math.round(x) : x.toFixed(2))).join(",") +
                  ")";
                (out.borders[key] ||= []).push(label(el));
              }
            }
          }
        if (
          el.matches(
            "input[type=date],input[type=time],input[type=datetime-local],input[type=month],input[type=week],input[type=color]",
          ) ||
          (el.matches("select") && cs.appearance !== "none")
        )
          out.native.push(el.tagName.toLowerCase() + (el.type ? "[" + el.type + "]" : ""));
      }
    }
    // ---- Hard defects: overlaps, short labels that wrap, crowding the macOS window controls ----
    const painted = [],
      texts = [];
    for (const root of roots) {
      for (const el of [root, ...root.querySelectorAll("*")]) {
        if (!vis(el) || (el.closest("svg") && el.tagName !== "svg")) continue;
        const cs = getComputedStyle(el);
        if (cs.pointerEvents === "none" || (cs.position === "fixed" && el !== root)) continue;
        // Clickable things must never overlap each other (text is checked separately below).
        if (
          el.matches(
            "button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch]",
          )
        )
          painted.push({
            el,
            r: el.getBoundingClientRect(),
            what:
              label(el) +
              ' "' +
              (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 16) +
              '"',
          });
      }
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n; (n = tw.nextNode());) {
        const t = n.nodeValue.trim();
        const p = n.parentElement;
        if (!t || !p || !vis(p) || p.closest("svg,script,style")) continue;
        const rg = document.createRange();
        rg.selectNodeContents(n);
        const rects = [...rg.getClientRects()].filter((q) => q.width > 0);
        if (!rects.length) continue;
        const r = rg.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) continue;
        texts.push({ el: p, r, what: '"' + t.slice(0, 20) + '"' });
        const tops = [...new Set(rects.map((q) => Math.round(q.top / 3)))];
        const ws = getComputedStyle(p).whiteSpace;
        if (t.length <= 24 && tops.length > 1 && !/pre/.test(ws))
          defects.push("wraps onto " + tops.length + ' lines: "' + t + '"');
      }
    }
    // What actually shows: each box cut to its clipping ancestors (scrolled-away parts don't count).
    const clipTo = (el, r, self) => {
      let L = r.left,
        T = r.top,
        R = r.right,
        B = r.bottom;
      for (
        let a = self ? el : el.parentElement;
        a && a !== document.documentElement;
        a = a.parentElement
      ) {
        const cs = getComputedStyle(a);
        if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
        const b = a.getBoundingClientRect();
        L = Math.max(L, b.left);
        T = Math.max(T, b.top);
        R = Math.min(R, b.right);
        B = Math.min(B, b.bottom);
      }
      return { left: L, top: T, right: R, bottom: B };
    };
    for (const it of painted) it.r = clipTo(it.el, it.r, false);
    for (const it of texts) it.r = clipTo(it.el, it.r, true);
    const hit = (a, b, m = 2) =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > m &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > m;
    const related = (a, b) => a.contains(b) || b.contains(a);
    // Union-find so a row of overlapping circles counts as one overlap, not six.
    const items = [...painted, ...texts];
    const par = items.map((_, i) => i);
    const find = (i) => (par[i] === i ? i : (par[i] = find(par[i])));
    const pairs = [];
    for (let i = 0; i < items.length; i++)
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i],
          b = items[j];
        if (related(a.el, b.el) || !hit(a.r, b.r)) continue;
        // Text vs. text, or control vs. control; text inside a control is that control's own.
        const ai = i < painted.length,
          bi = j < painted.length;
        if (ai !== bi) continue;
        par[find(i)] = find(j);
        pairs.push(a.what + " × " + b.what);
      }
    if (pairs.length) {
      const groups = new Map();
      for (let i = 0; i < items.length; i++) {
        const r0 = find(i);
        if (!groups.has(r0)) groups.set(r0, []);
        groups.get(r0).push(items[i].what);
      }
      for (const g of groups.values())
        if (g.length > 1)
          defects.push(
            "overlap: " +
              g.slice(0, 4).join(" × ") +
              (g.length > 4 ? " (+" + (g.length - 4) + ")" : ""),
          );
    }
    const lights = document.getElementById("__mac-traffic-lights");
    if (lights) {
      const L = lights.getBoundingClientRect();
      const CLEAR = 12;
      for (const root of roots)
        for (const el of [
          root,
          ...root.querySelectorAll(
            "button,a[href],input,select,[role=button],[role=radio],[role=tab]",
          ),
        ]) {
          if (
            !vis(el) ||
            (el === root &&
              !el.matches("button,a[href],input,select,[role=button],[role=radio],[role=tab]"))
          )
            continue;
          const r = el.getBoundingClientRect();
          const sameBand = r.top < L.bottom && r.bottom > L.top;
          const gap = r.left - L.right;
          if (sameBand && r.right > L.left - CLEAR && gap < CLEAR)
            defects.push(
              "crowds the window controls: " +
                label(el) +
                ' "' +
                (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 16) +
                '" is ' +
                Math.round(gap) +
                "px from them (need " +
                CLEAR +
                ")",
            );
        }
    }
    const pct = (bad, n) => (n ? 1 - bad / n : 1);
    const distinct = Object.keys(out.sizes).length;
    const nb = Object.keys(out.borders).length;
    const s = {
      clip: 10 * pct(out.clipped.length, out.text),
      contrast: 10 * pct(out.contrastFail.length, out.contrastN),
      type: Math.max(0, 10 * pct(out.offSize.length, out.text) - Math.max(0, distinct - 4)),
      controls: 10 * pct(out.ctlOff.length, out.ctlN),
      borders: Math.max(0, 10 - Math.max(0, nb - 3)),
      hit: 10 * pct(out.hitSmall.length, out.hitN),
      native: Math.max(0, 10 - 2 * out.native.length),
    };
    for (const k in s) s[k] = Math.round(s[k] * 10) / 10;
    const base = (Object.values(s).reduce((a, b) => a + b, 0) / Object.keys(s).length) * 10;
    const total = Math.max(0, Math.round(base - 15 * defects.length));
    const gate = {
      space: [out.spaceN, out.spaceOff.length],
      radius: [out.radN, out.radOff.length],
      color: [out.colN, out.colOff.length],
    };
    const top = (a) => [...new Set(a)].slice(0, 6);
    return {
      total,
      base: Math.round(base),
      defects,
      s,
      gate,
      borderKinds: Object.fromEntries(
        Object.entries(out.borders).map(([k, v]) => [
          k,
          [...new Set(v)].slice(0, 4).join(" ") + " ×" + v.length,
        ]),
      ),
      n: {
        text: out.text,
        clipped: out.clipped.length,
        contrast: out.contrastN,
        contrastFail: out.contrastFail.length,
        sizes: out.sizes,
        space: out.spaceN,
        spaceOff: out.spaceOff.length,
        rad: out.radN,
        radOff: out.radOff.length,
        col: out.colN,
        colOff: out.colOff.length,
        hit: out.hitN,
        hitSmall: out.hitSmall.length,
        native: out.native.length,
      },
      ex: {
        clipped: top(out.clipped),
        contrast: top(out.contrastFail),
        size: top(out.offSize),
        space: top(out.spaceOff),
        radius: top(out.radOff),
        color: top(out.colOff),
        hit: top(out.hitSmall),
        controls: top(out.ctlOff),
        native: top(out.native),
      },
    };
  };
  return "ok";
})();
