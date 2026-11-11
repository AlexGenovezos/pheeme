// Runs in the page (see run.mjs): window.__score(root) measures one part of the UI and scores it.
// The rules are described in README.md; keep the two in step.
(() => {
  // ---- Colour ---------------------------------------------------------------------------------
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  /** Any CSS colour as [r, g, b, a], or null when it isn't one. */
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
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => {
    const x = lum(a);
    const y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  /** The colours a gradient is drawn with (its stops), or null for an image. */
  function gradientStops(img) {
    if (img.includes("url(")) return null;
    const found =
      img.match(
        /(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\([^()]*(?:\([^()]*\)[^()]*)*\)|#[0-9a-f]{3,8}\b/gi,
      ) || [];
    const stops = found.map(parse).filter(Boolean);
    // Between two stops the colour passes through every mix of them; sample the way, so a
    // mid-gradient colour that matches the text can't hide between two good ends.
    const out = [...stops];
    for (let i = 1; i < stops.length; i++)
      for (let k = 1; k < 16; k++) {
        const t = k / 16;
        out.push(stops[i - 1].map((v, j) => v * (1 - t) + stops[i][j] * t));
      }
    return out;
  }
  /**
   * The text's colour and every background it can sit on, opacity included. A gradient adds each
   * of its stops (the worst one counts); an image behind the text makes it unverifiable.
   */
  function backdrops(el, colorOf) {
    const chain = [];
    for (let a = el; a; a = a.parentElement) chain.unshift(a);
    let Bs = [[255, 255, 255, 1]];
    const groups = [];
    let unverified = false;
    for (const a of chain) {
      const cs = getComputedStyle(a);
      const o = parseFloat(cs.opacity);
      if (o < 1) groups.push({ o, outside: Bs[0] });
      const bg = parse(cs.backgroundColor);
      if (bg && bg[3] > 0) {
        Bs = Bs.map((b) => over(bg, b));
        if (bg[3] === 1) unverified = false;
      }
      if (cs.backgroundImage !== "none") {
        const stops = gradientStops(cs.backgroundImage);
        if (!stops) unverified = true;
        else if (stops.length) Bs = stops.flatMap((s) => Bs.map((b) => over(s, b)));
      }
    }
    const fg = parse(colorOf);
    return Bs.map((B) => {
      let T = over(fg, B);
      let b = B;
      for (let i = groups.length - 1; i >= 0; i--) {
        T = mix(T, groups[i].outside, groups[i].o);
        b = mix(b, groups[i].outside, groups[i].o);
      }
      return { T, B: b };
    }).concat(unverified ? [null] : []);
  }

  // ---- Geometry -------------------------------------------------------------------------------
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      el.checkVisibility({ visibilityProperty: true }) &&
      r.bottom > 0 &&
      r.right > 0 &&
      r.top < innerHeight &&
      r.left < innerWidth
    );
  };
  const scrolls = (v) => v === "auto" || v === "scroll";
  /** What of `r` actually shows: cut, axis by axis, to each ancestor that clips that axis. */
  function clipTo(el, r, self) {
    let { left: L, top: T, right: R, bottom: B } = r;
    for (
      let a = self ? el : el.parentElement;
      a && a !== document.documentElement;
      a = a.parentElement
    ) {
      const cs = getComputedStyle(a);
      const b = a.getBoundingClientRect();
      if (cs.overflowX !== "visible") {
        L = Math.max(L, b.left);
        R = Math.min(R, b.right);
      }
      if (cs.overflowY !== "visible") {
        T = Math.max(T, b.top);
        B = Math.min(B, b.bottom);
      }
    }
    return { left: L, top: T, right: R, bottom: B };
  }
  const label = (el) =>
    (typeof el.className === "string" && el.className
      ? "." + el.className.split(" ")[0]
      : el.tagName.toLowerCase()) +
    ' "' +
    (el.getAttribute("aria-label") || el.textContent || el.value || el.placeholder || "")
      .trim()
      .slice(0, 18) +
    '"';
  const INTERACTIVE =
    "button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=gridcell][tabindex]";
  // Variable-size content (events, chips, rows, mini-month days): no fixed control height.
  const CONTENT =
    ".cal-event,.task-chip,.thread-row,.cal-search__row,.mini-month button,.task-row__main,.ui-picker [role=option],.ui-picker [role=gridcell]";
  /** The box that takes a click: a wrapped field's frame, a checkbox's label. */
  function hitBox(el, r) {
    if (!el.matches("input,select,textarea")) return r;
    const w = el.parentElement && el.parentElement.closest('label, .ui-input, [class*="field"]');
    if (w && w.querySelectorAll("input,select,textarea").length === 1) {
      const b = w.getBoundingClientRect();
      if (b.width >= r.width && b.height >= r.height) return b;
    }
    return r;
  }
  /** Inline styles that carry a user's colour (calendar and label colours), not layout. */
  function userColored(el, root) {
    for (let a = el; a && a !== root.parentElement; a = a.parentElement) {
      const st = a.style;
      if (!st) continue;
      for (let i = 0; i < st.length; i++) {
        const p = st[i];
        if (/^(color|background|background-color|border-color)$/.test(p)) return true;
        if (p.startsWith("--") && parse(st.getPropertyValue(p).trim())) return true;
      }
    }
    return false;
  }

  // ---- Scales ---------------------------------------------------------------------------------
  const FONT = [11, 12, 13, 15, 16, 18, 22, 28];
  const CONTROL_HEIGHTS = [24, 28, 32];
  const MIN_TARGET = 24;
  // A criterion under this is a hard defect of its own. Not clipped text: ending a long label in
  // "…" is normal, and unreadable text is the "cut" defect.
  const WEAK = 7;

  window.__score = (rootSel) => {
    const roots = (
      typeof rootSel === "string" ? [...document.querySelectorAll(rootSel)] : [rootSel]
    ).filter(Boolean);
    const o = {
      text: 0,
      clipped: [],
      contrastN: 0,
      contrastFail: [],
      sizes: {},
      offSize: [],
      hitN: 0,
      hitSmall: [],
      native: [],
      ctlN: 0,
      ctlOff: [],
      borders: {},
    };
    const defects = [];
    const texts = []; // { el, r, what, own } for overlap checks
    const controls = [];

    // A text item is a text node, or the value/placeholder a field shows.
    function textItem(el, t, r, cs, colorOf, inField) {
      const fs = Math.round(parseFloat(cs.fontSize) * 10) / 10;
      // Shown in full? A field shows what fits its content box (a value or a placeholder alike);
      // a textarea that can't scroll shows what fits its height. Elsewhere, check every
      // clipping/scrolling ancestor.
      let clipped = false;
      let hidden = false;
      if (inField === "input") {
        cx.font = cs.font || `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const box = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        clipped = cx.measureText(t).width > box + 1;
      } else if (inField === "textarea")
        clipped = el.scrollHeight > el.clientHeight + 1 && !scrolls(cs.overflowY);
      for (
        let a = inField ? el.parentElement : el;
        a && a !== document.documentElement;
        a = a.parentElement
      ) {
        const c = getComputedStyle(a);
        if (c.overflowX === "visible" && c.overflowY === "visible") continue;
        const b = a.getBoundingClientRect();
        const outL = r.left < b.left - 1,
          outR = r.right > b.right + 1,
          outT = r.top < b.top - 1,
          outB = r.bottom > b.bottom + 1;
        const allOutX = r.right <= b.left || r.left >= b.right,
          allOutY = r.bottom <= b.top || r.top >= b.bottom;
        if ((c.overflowX !== "visible" && allOutX) || (c.overflowY !== "visible" && allOutY)) {
          // Scrolled away, or inside a box that is itself hidden (a 1 px screen-reader-only box,
          // a closed section): not on screen. Cut off whole by a box that shows: clipped.
          const scrolledAway =
            (allOutX && scrolls(c.overflowX)) || (allOutY && scrolls(c.overflowY));
          if (scrolledAway || b.width <= 1 || b.height <= 1) {
            hidden = true;
            break;
          }
          clipped = true;
          continue;
        }
        // Sideways overflow always hides part of a label (nobody scrolls sideways to read it);
        // vertical overflow in a scrolling list is just scrolling.
        if (c.overflowX !== "visible" && (outL || outR)) clipped = true;
        if (c.overflowY !== "visible" && !scrolls(c.overflowY) && (outT || outB)) clipped = true;
      }
      if (hidden) return;
      o.text++;
      if (clipped) {
        o.clipped.push(t.slice(0, 40));
        const box = clipTo(el, inField ? el.getBoundingClientRect() : r, !!inField);
        const pad = inField ? parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) : 0;
        const em = parseFloat(cs.fontSize);
        const chars = Math.floor(
          (box.right - box.left - pad - (cs.textOverflow === "ellipsis" ? 0.6 * em : 0)) /
            (0.55 * em),
        );
        if (t.length > 3 && chars < 3)
          defects.push("cut to " + Math.max(0, chars) + ' characters: "' + t.slice(0, 24) + '"');
      }
      o.sizes[fs] = (o.sizes[fs] || 0) + 1;
      if (!FONT.includes(fs)) o.offSize.push(fs + 'px "' + t.slice(0, 20) + '"');
      if (!el.closest('[disabled],[aria-disabled="true"]')) {
        o.contrastN++;
        const big = fs >= 24 || (fs >= 18.66 && +cs.fontWeight >= 700);
        const need = big ? 3 : 4.5;
        const pairs = backdrops(el, colorOf);
        if (pairs.includes(null))
          o.contrastFail.push('unverifiable (image behind) "' + t.slice(0, 24) + '"');
        else {
          const worst = Math.min(...pairs.map((p) => ratio(p.T, p.B)));
          if (worst < need) o.contrastFail.push(worst.toFixed(2) + ' "' + t.slice(0, 24) + '"');
        }
      }
    }

    for (const root of roots) {
      // Text nodes.
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n; (n = tw.nextNode());) {
        const t = n.nodeValue.trim();
        const p = n.parentElement;
        if (!t || !p || !vis(p) || p.closest('svg,script,style,[aria-hidden="true"]')) continue;
        const rg = document.createRange();
        rg.selectNodeContents(n);
        const r = rg.getBoundingClientRect();
        if (!r.width) continue;
        const cs = getComputedStyle(p);
        const before = o.text;
        textItem(p, t, r, cs, cs.color, false);
        if (o.text === before) continue;
        texts.push({ el: p, r: clipTo(p, r, true), what: '"' + t.slice(0, 20) + '"' });
        const tops = new Set(
          [...rg.getClientRects()].filter((q) => q.width > 0).map((q) => Math.round(q.top / 3)),
        );
        if (t.length <= 24 && tops.size > 1 && !/pre/.test(cs.whiteSpace))
          defects.push("wraps onto " + tops.size + ' lines: "' + t + '"');
      }
      // What fields show: their value, else their placeholder.
      for (const f of root.querySelectorAll(
        "input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=range]),textarea",
      )) {
        if (!vis(f)) continue;
        const t = (f.value || f.placeholder || "").trim();
        if (!t) continue;
        const cs = getComputedStyle(f);
        let color = cs.color;
        if (!f.value) {
          // The placeholder's own colour, faded by its own opacity.
          const ph = getComputedStyle(f, "::placeholder");
          const c = parse(ph.color) || [0, 0, 0, 1];
          color = `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${c[3] * parseFloat(ph.opacity || "1")})`;
        }
        textItem(
          f,
          t,
          f.getBoundingClientRect(),
          cs,
          color,
          f.tagName === "INPUT" ? "input" : "textarea",
        );
      }

      for (const el of [root, ...root.querySelectorAll("*")]) {
        if (!vis(el) || (el.closest("svg") && el.tagName !== "svg")) continue;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const interactive = el.matches(INTERACTIVE);
        if (interactive) {
          const box = hitBox(el, r);
          o.hitN++;
          if (box.width < MIN_TARGET - 0.5 || box.height < MIN_TARGET - 0.5)
            o.hitSmall.push(label(el) + " " + Math.round(box.width) + "x" + Math.round(box.height));
          if (cs.pointerEvents !== "none")
            controls.push({ el, r: clipTo(el, box, false), what: label(el) });
          const labelled =
            el.matches("input,select,[role=combobox]") || (el.textContent || "").trim();
          if (
            labelled &&
            !el.matches("textarea,input[type=checkbox],input[type=radio]") &&
            !el.closest(CONTENT)
          ) {
            o.ctlN++;
            const h = Math.round(box.height * 2) / 2;
            if (!CONTROL_HEIGHTS.includes(h)) o.ctlOff.push(label(el) + " h=" + h);
          }
        }
        if (!el.closest(CONTENT) && !userColored(el, root))
          for (const sd of ["Top", "Right", "Bottom", "Left"]) {
            const w = parseFloat(cs["border" + sd + "Width"]);
            if (!(w > 0) || cs["border" + sd + "Style"] === "none") continue;
            const c = parse(cs["border" + sd + "Color"]);
            if (!c || !c[3]) continue;
            const key =
              w +
              "px " +
              cs["border" + sd + "Style"] +
              " rgba(" +
              c.map((x, i) => (i < 3 ? Math.round(x) : x.toFixed(2))).join(",") +
              ")";
            (o.borders[key] ||= []).push(label(el));
          }
        if (
          el.matches(
            "input[type=date],input[type=time],input[type=datetime-local],input[type=month],input[type=week],input[type=color]",
          ) ||
          (el.matches("select") && cs.appearance !== "none")
        )
          o.native.push(el.tagName.toLowerCase() + (el.type ? "[" + el.type + "]" : ""));
      }
    }

    // ---- Hard defects ---------------------------------------------------------------------------
    // Overlap: text on text, a control on a control, or a control over text that isn't its own.
    const hit = (a, b) =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2;
    const items = [
      ...texts.map((t) => ({ ...t, kind: "text" })),
      ...controls.map((c) => ({ ...c, kind: "control" })),
    ];
    const par = items.map((_, i) => i);
    const find = (i) => (par[i] === i ? i : (par[i] = find(par[i])));
    for (let i = 0; i < items.length; i++)
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        if (a.el.contains(b.el) || b.el.contains(a.el) || !hit(a.r, b.r)) continue;
        // A text inside a control, or the control's own <label>, is that control's; a control over
        // a text in another control is the same pair as control over control.
        const ctl = a.kind === "control" ? a : b.kind === "control" ? b : null;
        const txt = a.kind === "text" ? a : b.kind === "text" ? b : null;
        const ownLabel = ctl && txt && [...(ctl.el.labels || [])].some((l) => l.contains(txt.el));
        if (ctl && txt && (ctl.el.contains(txt.el) || ownLabel || txt.el.closest(INTERACTIVE)))
          continue;
        par[find(i)] = find(j);
      }
    const groups = new Map();
    items.forEach((it, i) => {
      const g = find(i);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(it.what);
    });
    for (const g of groups.values())
      if (g.length > 1)
        defects.push(
          "overlap: " +
            g.slice(0, 4).join(" × ") +
            (g.length > 4 ? " (+" + (g.length - 4) + ")" : ""),
        );

    // Covered: every control in the part must be reachable: the centre of what shows of it has to
    // hit it (or its own label), with toasts and other layers present. One defect per covering thing.
    const coveredBy = new Map();
    for (const c of controls) {
      const r = c.r;
      const x = (r.left + r.right) / 2;
      const y = (r.top + r.bottom) / 2;
      if (
        r.right - r.left < 4 ||
        r.bottom - r.top < 4 ||
        x < 0 ||
        y < 0 ||
        x > innerWidth ||
        y > innerHeight
      )
        continue;
      const at = document.elementFromPoint(x, y);
      if (!at || c.el.contains(at) || at.contains(c.el)) continue;
      if ([...(c.el.labels || [])].some((l) => l.contains(at))) continue;
      const by =
        at.closest(".ui-toast, [role=dialog], [role=listbox], aside, header, nav, main, section") ||
        at;
      if (!coveredBy.has(by)) coveredBy.set(by, []);
      coveredBy.get(by).push(c.what);
    }
    for (const [by, list] of coveredBy)
      defects.push(
        "covered: " +
          list.slice(0, 3).join(", ") +
          (list.length > 3 ? " (+" + (list.length - 3) + ")" : "") +
          " under " +
          label(by),
      );

    // Window controls: nothing within 12 px of the macOS traffic lights.
    const lights = document.getElementById("__mac-traffic-lights");
    if (lights) {
      const L = lights.getBoundingClientRect();
      for (const c of controls) {
        const r = c.el.getBoundingClientRect();
        const gap = r.left - L.right;
        if (r.top < L.bottom && r.bottom > L.top && r.right > L.left - 12 && gap < 12)
          defects.push(
            "crowds the window controls: " +
              c.what +
              " is " +
              Math.round(gap) +
              "px from them (need 12)",
          );
      }
    }

    const pct = (bad, n) => (n ? 1 - bad / n : 1);
    const distinct = Object.keys(o.sizes).length;
    const s = {
      clip: 10 * pct(o.clipped.length, o.text),
      contrast: 10 * pct(o.contrastFail.length, o.contrastN),
      type: Math.max(0, 10 * pct(o.offSize.length, o.text) - Math.max(0, distinct - 4)),
      controls: 10 * pct(o.ctlOff.length, o.ctlN),
      borders: Math.max(0, 10 - Math.max(0, Object.keys(o.borders).length - 3)),
      hit: 10 * pct(o.hitSmall.length, o.hitN),
      native: Math.max(0, 10 - 2 * o.native.length),
    };
    for (const k in s) {
      s[k] = Math.round(s[k] * 10) / 10;
      if (k !== "clip" && s[k] < WEAK)
        defects.push("weak criterion: " + k + " " + s[k] + "/10 (under " + WEAK + ")");
    }
    if (!o.text) defects.push("nothing measured: no text found in the part");
    const base = (Object.values(s).reduce((a, b) => a + b, 0) / Object.keys(s).length) * 10;
    const total = Math.max(0, Math.round(base - 15 * defects.length));
    const top = (a) => [...new Set(a)].slice(0, 6);
    return {
      total,
      base: Math.round(base),
      defects,
      s,
      n: {
        text: o.text,
        clipped: o.clipped.length,
        contrast: o.contrastN,
        contrastFail: o.contrastFail.length,
        sizes: o.sizes,
        hit: o.hitN,
        hitSmall: o.hitSmall.length,
        controls: o.ctlN,
        ctlOff: o.ctlOff.length,
        native: o.native.length,
      },
      borderKinds: Object.fromEntries(
        Object.entries(o.borders).map(([k, v]) => [
          k,
          [...new Set(v)].slice(0, 4).join(" ") + " ×" + v.length,
        ]),
      ),
      ex: {
        clipped: top(o.clipped),
        contrast: top(o.contrastFail),
        size: top(o.offSize),
        hit: top(o.hitSmall),
        controls: top(o.ctlOff),
        native: top(o.native),
      },
    };
  };
  return "ok";
})();
