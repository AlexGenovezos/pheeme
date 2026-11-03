#!/usr/bin/env bash
# Builds the desktop app icon (../src-tauri/app-icon.svg): the Fama statue's head and
# trumpet, line-engraved as pure vector.
#
# Source: "Gold (82911013).jpeg" by Etrick, CC BY 3.0
#   https://commons.wikimedia.org/wiki/File:Gold_(82911013).jpeg
# This is a different photo from the site's stamp art (build-fama.sh): it is CC BY, not
# CC BY-SA, so the icon only needs the credit and does not inherit share-alike.
#
# Usage: scripts/build-fama-icon.sh   (needs ImageMagick 7 and python3)
# Then run `npm run icons` in the repo root to make every platform size.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=brand-src/fama-icon-source.jpg
OUT=../src-tauri/app-icon.svg
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# 1. Frame the head and trumpet, then work at 512 px.
magick "$SRC" -crop 340x340+560+540 +repage -resize 512x512 "$WORK/sq.png"

# 2. Cut the gilded statue out of the sky (gold is saturated, the sky isn't).
magick "$WORK/sq.png" -colorspace HSL -channel G -separate +channel -threshold 48% \
  -morphology Open Disk:1 -morphology Close Disk:2 \
  -define connected-components:area-threshold=800 -define connected-components:mean-color=true \
  -connected-components 8 "$WORK/mask.png"
magick "$WORK/mask.png" -blur 0x1.5 -depth 8 -compress none "$WORK/mask.pgm"

# 3. Parts too thin to carry engraving lines (the trumpet tube): the mask minus its opening.
magick "$WORK/mask.png" -alpha off -colorspace gray \( +clone -morphology Open Disk:6 \) \
  -compose Difference -composite -morphology Open Disk:2 -blur 0x1 -depth 8 -compress none "$WORK/thin.pgm"

# 4. Tone.
magick "$WORK/sq.png" -colorspace gray -blur 0x0.8 -depth 8 -compress none "$WORK/gray.pgm"

python3 scripts/engrave-icon.py "$WORK" "$OUT"
