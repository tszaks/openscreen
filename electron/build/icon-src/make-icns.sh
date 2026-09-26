#!/bin/bash
# make-icns.sh <concept.svg> [out-dir]
# Renders a macOS iconset (16-1024 px, @1x/@2x) from one SVG and packs it with
# iconutil into <out-dir>/icon.icns, plus <out-dir>/icon.png at 1024.
# If <concept>-small.svg exists it is used for the 16 and 32 px renders.
# out-dir defaults to electron/build, i.e. it replaces the shipped icon.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
svg=$1
out=${2:-$(dirname "$here")}
small=${svg%.svg}-small.svg; [ -f "$small" ] || small=$svg
mkdir -p "$out"
set_dir=$(mktemp -d -t openscreen)/icon.iconset; mkdir -p "$set_dir"

for pt in 16 32 128 256 512; do
  for scale in 1 2; do
    px=$(( pt * scale ))
    name=icon_${pt}x${pt}; [ $scale = 2 ] && name=${name}@2x
    src=$svg; [ $px -le 32 ] && src=$small
    "$here/render.sh" "$src" "$px" "$set_dir/$name.png"
    got=$(sips -g pixelWidth "$set_dir/$name.png" | awk '/pixelWidth/{print $2}')
    [ "$got" = "$px" ] || { echo "$name.png is ${got}px, expected $px" >&2; exit 1; }
  done
done

iconutil -c icns "$set_dir" -o "$out/icon.icns"
cp "$set_dir/icon_512x512@2x.png" "$out/icon.png"
echo "wrote $out/icon.icns ($(ls "$set_dir" | wc -l | tr -d ' ') sizes) and $out/icon.png"
rm -rf "$(dirname "$set_dir")"
