#!/usr/bin/env bash
# Builds the gold-halftone Fama (Pheme) art used on the site.
#
# Source: "Dresden Fama (2005).jpg" by Brunswyk, CC BY-SA 3.0
#   https://commons.wikimedia.org/wiki/File:Dresden_Fama_(2005).jpg
# Our edits (cut-out, halftone, recolor) are released under the same license.
#
# Usage: scripts/build-fama.sh   (needs ImageMagick 7 with WebP)
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=brand-src/fama-source.jpg
OUT=public/art
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

DARK="#173C92"   # shadows -> envelope blue
LIGHT="#F3D690"  # highlights -> wing gold

# 1. Cut the gilded statue out of the grey sky: gold is saturated, sky isn't.
#    Crop off the dark pedestal under the ball first.
magick "$SRC" -crop 1486x2300+0+0 +repage "$WORK/src.png"
magick "$WORK/src.png" -colorspace HSL -channel G -separate +channel \
  -threshold 22% -morphology Open Disk:2 -morphology Close Disk:3 \
  -define connected-components:area-threshold=5000 -define connected-components:mean-color=true \
  -connected-components 8 "$WORK/mask.png"

# halftone <input> <mask> <width> <out> : gold/blue dots, transparent background
halftone() {
  local in=$1 mask=$2 width=$3 out=$4
  magick "$in" -resize "${width}x" -colorspace gray -sigmoidal-contrast 5,45% \
    -ordered-dither h6x6a -colorspace sRGB +level-colors "$DARK,$LIGHT" \
    \( "$mask" -resize "${width}x" -threshold 50% \) \
    -alpha off -compose CopyOpacity -composite "$out"
}

# 2. Full statue (hero)
halftone "$WORK/src.png" "$WORK/mask.png" 900 "$WORK/fama.png"
magick "$WORK/fama.png" -trim +repage -define webp:lossless=true "$OUT/fama.webp"

# 3. Detail: head, trumpet and wings (the "why the name" section)
magick "$WORK/src.png" -crop 1300x900+100+100 +repage "$WORK/detail.png"
magick "$WORK/mask.png" -crop 1300x900+100+100 +repage "$WORK/detail-mask.png"
halftone "$WORK/detail.png" "$WORK/detail-mask.png" 1100 "$WORK/fama-detail.png"
magick "$WORK/fama-detail.png" -define webp:lossless=true "$OUT/fama-detail.webp"

# 4. PNG copy for the social card template
cp "$WORK/fama.png" brand-src/fama-halftone.png
magick identify "$OUT"/*.webp
