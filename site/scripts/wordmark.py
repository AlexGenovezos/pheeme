"""Convert the "pheeme" wordmark into an SVG path (outlined text, no font dependency).

Usage: uv run --with fonttools python -I scripts/wordmark.py <Poppins-SemiBold.ttf> [tracking]
Prints JSON: {"d": path, "width": w, "ascender": a, "xheight": x, "descender": d}
"""
import json, sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

font = TTFont(sys.argv[1])
tracking = float(sys.argv[2]) if len(sys.argv) > 2 else -20  # font units
gs = font.getGlyphSet()
cmap = font.getBestCmap()
hmtx = font["hmtx"]
os2 = font["OS/2"]
text = "pheeme"
pen = SVGPathPen(gs)
x = 0
for ch in text:
    name = cmap[ord(ch)]
    # flip y: font units are y-up, SVG is y-down; baseline at y=0
    tp = TransformPen(pen, (1, 0, 0, -1, x, 0))
    gs[name].draw(tp)
    x += hmtx[name][0] + tracking
x -= tracking
print(json.dumps({
    "d": pen.getCommands(),
    "width": x,
    "upm": font["head"].unitsPerEm,
    "ascender": os2.sTypoAscender,
    "xheight": os2.sxHeight,
    "capheight": os2.sCapHeight,
    "descender": os2.sTypoDescender,
}))
