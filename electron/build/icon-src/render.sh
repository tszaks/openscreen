#!/bin/bash
# render.sh <svg> <size> <out.png>  — rasterise an SVG with headless Chrome, transparent bg.
# Chrome sometimes writes the screenshot and then never exits (e.g. display asleep),
# so wait for the file and stop the process ourselves.
set -euo pipefail
svg=$(cd "$(dirname "$1")" && pwd)/$(basename "$1"); size=$2; out=$3
html=$(mktemp -t iconrender).html; prof=$(mktemp -d -t iconchrome); log=$(mktemp -t iconlog)
rm -f "$out"
printf '<html><body style="margin:0;background:transparent"><img src="file://%s" width="%s" height="%s" style="display:block"></body></html>' "$svg" "$size" "$size" > "$html"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --user-data-dir="$prof" --default-background-color=00000000 --force-device-scale-factor=1 \
  --window-size="$size,$size" --screenshot="$out" "file://$html" >"$log" 2>&1 &
pid=$!
for _ in $(seq 1 150); do [ -s "$out" ] && break; kill -0 $pid 2>/dev/null || break; sleep 0.2; done
sleep 0.3; kill $pid 2>/dev/null || true; wait $pid 2>/dev/null || true
if [ ! -s "$out" ]; then echo "render failed for $svg @ $size" >&2; tail -20 "$log" >&2; exit 1; fi
rm -rf "$html" "$prof" "$log"
