#!/usr/bin/env bash
# Builds the line-engraved Fama (Pheme) art used on the stamp.
#
# Source: "Dresden Fama (2005).jpg" by Brunswyk, CC BY-SA 3.0
#   https://commons.wikimedia.org/wiki/File:Dresden_Fama_(2005).jpg
# Our edits (cut-out, line engraving, recolor) are released under the same license.
#
# Usage: scripts/build-fama.sh   (needs ImageMagick 7 with WebP)
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=brand-src/fama-source.jpg
OUT=public/art
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

INK="#16388A"
W=1400          # output width; the zoom scene scales this up to ~2.4x
PERIOD=9        # engraving line spacing in output pixels

# 1. Crop off the pedestal, then cut the gilded statue out of the grey sky:
#    gold is saturated, the sky isn't. Keep only big connected regions.
magick "$SRC" -crop 1486x2300+0+0 +repage -resize "${W}x" "$WORK/src.png"
magick "$WORK/src.png" -colorspace HSL -channel G -separate +channel \
  -threshold 22% -morphology Open Disk:2 -morphology Close Disk:3 \
  -define connected-components:area-threshold=6000 -define connected-components:mean-color=true \
  -connected-components 8 "$WORK/mask.png"

# 2. Tone: flatten the gilding into a clean light-to-dark ramp.
magick "$WORK/src.png" -colorspace gray -level 12%,88% -sigmoidal-contrast 6,48% -blur 0x1 "$WORK/gray.png"

# 3. Engrave: wavy horizontal lines whose thickness follows darkness.
#    Inside the statue the line weight tracks the tone; the sky gets hairlines.
magick "$WORK/gray.png" "$WORK/mask.png" -fx "
  per=$PERIOD; wav=j + 6*sin(i/120) + 3*sin(i/41);
  val=0.5+0.5*sin(2*pi*wav/per);
  dk = v > 0.5 ? pow(1-u,1.2)*0.97 : 0.07;
  val < dk ? 0 : 1" "$WORK/lines.png"

# 4. Outline the figure so it separates from the engraved sky.
magick "$WORK/mask.png" -morphology EdgeOut Disk:3 -negate "$WORK/edge.png"
magick "$WORK/lines.png" "$WORK/edge.png" -compose Multiply -composite -negate "$WORK/ink.png"

# 5. Ink on transparent, cropped to the stamp window (trumpet to the top of the orb).
H=$(magick identify -format %h "$WORK/src.png")
magick -size "${W}x${H}" xc:"$INK" "$WORK/ink.png" -alpha off -compose CopyOpacity -composite \
  -crop "${W}x1835+0+0" +repage -define webp:lossless=true "$OUT/fama-engraved.webp"
magick identify "$OUT/fama-engraved.webp"
