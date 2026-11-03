#!/usr/bin/env python3
"""Line-engrave the Fama statue into the desktop app icon, as pure vector.

Called by build-fama-icon.sh, which prepares three square greyscale PGMs of the
same size from the photo:
  gray.pgm   tone (light = highlight)
  mask.pgm   the statue (white) cut out of the sky
  thin.pgm   parts of the statue too thin to engrave (the trumpet tube): drawn solid

Each engraving line is a filled polygon whose thickness follows the tone, the way a
sine-threshold engraving would (see build-fama.sh), so the icon stays sharp at any size.
The statue outline is a marching-squares contour of the mask.

Usage: engrave-icon.py WORKDIR OUT.svg
"""
import math
import sys

WORK, OUT = sys.argv[1], sys.argv[2]

INK = "#16388A"
PAPER = "#F4F1E8"
PERIOD = 15.0      # line spacing in art units
SKY = 0.07         # ink share for the sky hairlines
GAMMA = 1.6        # tone curve for the gilding
ART = 824          # macOS draws Dock icons as an 824 px squircle on a 1024 canvas
CANVAS = 1024
RADIUS = 185


def pgm(path):
    t = open(path).read().split()
    w, h, mx = int(t[1]), int(t[2]), int(t[3])
    assert w == h, "expected square maps"
    return w, [int(v) / mx for v in t[4:4 + w * h]]


N, gray = pgm(f"{WORK}/gray.pgm")
_, mask = pgm(f"{WORK}/mask.pgm")
_, thin = pgm(f"{WORK}/thin.pgm")
k = N / ART

# Stretch the tone over the statue's own range, so the gilding spans light to dark.
vals = sorted(g for g, m in zip(gray, mask) if m > 0.5)
lo, hi = vals[int(len(vals) * .03)], vals[int(len(vals) * .97)]
tone = [min(1.0, max(0.0, (g - lo) / (hi - lo))) ** GAMMA if m > 0.2 else 1.0 for g, m in zip(gray, mask)]


def sample(img, x, y):
    u = min(max(x * k, 0), N - 1.001)
    v = min(max(y * k, 0), N - 1.001)
    i, j = int(u), int(v)
    fu, fv = u - i, v - j
    g = lambda a, b: img[b * N + a]
    return (g(i, j) * (1 - fu) * (1 - fv) + g(i + 1, j) * fu * (1 - fv)
            + g(i, j + 1) * (1 - fu) * fv + g(i + 1, j + 1) * fu * fv)


def darkness(x, y):
    m = sample(mask, x, y)
    inside = max(0.0, 1 - sample(tone, x, y)) ** 1.2 * 0.97
    inside = max(inside, sample(thin, x, y))
    return SKY * (1 - m) + inside * m


def wave(x, y0):
    return y0 + 5 * math.sin(x / 95) + 2.4 * math.sin(x / 33)


def engraving():
    parts = []
    y0 = -PERIOD
    while y0 < ART + PERIOD:
        top, bot = [], []
        x = -6.0
        while x <= ART + 6:
            y = wave(x, y0)
            dk = min(1.0, darkness(x, y))
            half = math.acos(1 - 2 * dk) / math.pi * PERIOD / 2  # ink share of one period
            top.append((x, y - half))
            bot.append((x, y + half))
            x += 6
        parts.append("M" + "L".join(f"{a:.0f} {b:.1f}" for a, b in top + bot[::-1]) + "Z")
        y0 += PERIOD
    return " ".join(parts)


def outline():
    def cross(p, q, a, b):
        t = 0.5 if a == b else min(1, max(0, (0.5 - a) / (b - a)))
        return (p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)

    cases = {1: ["lt"], 2: ["tr"], 3: ["lr"], 4: ["rb"], 5: ["lt", "rb"], 6: ["tb"], 7: ["lb"],
             8: ["bl"], 9: ["tb"], 10: ["tr", "bl"], 11: ["rb"], 12: ["lr"], 13: ["tr"], 14: ["lt"]}
    edges = []
    for j in range(N - 1):
        for i in range(N - 1):
            a, b = mask[j * N + i], mask[j * N + i + 1]
            c, d = mask[(j + 1) * N + i + 1], mask[(j + 1) * N + i]
            idx = (a > .5) + (b > .5) * 2 + (c > .5) * 4 + (d > .5) * 8
            if idx in (0, 15):
                continue
            p = {"t": cross((i, j), (i + 1, j), a, b), "r": cross((i + 1, j), (i + 1, j + 1), b, c),
                 "b": cross((i, j + 1), (i + 1, j + 1), d, c), "l": cross((i, j), (i, j + 1), a, d)}
            edges += [(p[e[0]], p[e[1]]) for e in cases[idx]]

    key = lambda p: (round(p[0], 3), round(p[1], 3))
    at = {}
    for e in edges:
        at.setdefault(key(e[0]), []).append(e)
        at.setdefault(key(e[1]), []).append(e)
    used, chains = set(), []
    for e in edges:
        if id(e) in used:
            continue
        used.add(id(e))
        chain = [e[0], e[1]]
        for forward in (True, False):
            while True:
                end = chain[-1] if forward else chain[0]
                nxt = next((f for f in at.get(key(end), []) if id(f) not in used), None)
                if not nxt:
                    break
                used.add(id(nxt))
                q = nxt[1] if key(nxt[0]) == key(end) else nxt[0]
                chain.append(q) if forward else chain.insert(0, q)
        if len(chain) > 25:  # drop specks
            chains.append(chain)

    def smooth(c):
        for _ in range(2):
            c = [((c[i][0] + c[i + 1][0]) / 2, (c[i][1] + c[i + 1][1]) / 2) for i in range(len(c) - 1)]
        return c[::2]

    return " ".join("M" + "L".join(f"{x / k:.1f} {y / k:.1f}" for x, y in smooth(c)) for c in chains)


pad = (CANVAS - ART) / 2
svg = (
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {CANVAS} {CANVAS}">'
    f'<defs><clipPath id="sq"><rect x="{pad:g}" y="{pad:g}" width="{ART}" height="{ART}" rx="{RADIUS}"/></clipPath></defs>'
    f'<rect x="{pad:g}" y="{pad:g}" width="{ART}" height="{ART}" rx="{RADIUS}" fill="{PAPER}"/>'
    f'<g clip-path="url(#sq)"><g transform="translate({pad:g} {pad:g})">'
    f'<path fill="{INK}" d="{engraving()}"/>'
    f'<path fill="none" stroke="{INK}" stroke-width="{PERIOD * 0.42:.1f}" stroke-linejoin="round" '
    f'stroke-linecap="round" d="{outline()}"/>'
    '</g></g></svg>\n'
)
open(OUT, "w").write(svg)
print(f"{OUT}: {len(svg) // 1024} KB")
