#!/bin/bash
# shutter-sheet.sh <out.png> <icon1.svg|.icns> [icon2 ...]
# Review sheet for the shutter round. One column per icon. Row 1 is the
# 1024 px master at true size. Rows 2 and 3 put the icon in a Dock at 128 px
# with 32 and 16 px beside it, on a dark and on a light desktop.
# Every size is rasterised on its own, the same way make-icns.sh builds the
# iconset (32 px and under use <name>-small.svg when it exists), so the sheet
# shows the pixels that ship rather than a browser-scaled 1024.
# An .icns column (the current icon) uses the sizes stored inside it.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=$1; shift
work=$(mktemp -d -t shuttersheet)

cols=""
for f in "$@"; do
  abs=$(cd "$(dirname "$f")" && pwd)/$(basename "$f")
  label=$(basename "${f%.*}")
  d="$work/$label"; mkdir -p "$d"
  if [[ $abs == *.icns ]]; then
    label="current icon"
    iconutil -c iconset "$abs" -o "$d/set.iconset"
    cp "$d/set.iconset/icon_512x512@2x.png" "$d/1024.png"
    cp "$d/set.iconset/icon_128x128.png" "$d/128.png"
    cp "$d/set.iconset/icon_32x32.png" "$d/32.png"
    cp "$d/set.iconset/icon_16x16.png" "$d/16.png"
  else
    small=${abs%.svg}-small.svg; [ -f "$small" ] || small=$abs
    "$here/render.sh" "$abs" 1024 "$d/1024.png"
    "$here/render.sh" "$abs" 128 "$d/128.png"
    "$here/render.sh" "$small" 32 "$d/32.png"
    "$here/render.sh" "$small" 16 "$d/16.png"
  fi
  desk() { printf '<div class="desk %s"><div class="dock"><div class="nb n1"></div><img src="%s/128.png" width=128 height=128><div class="nb n2"></div></div><div class="sizes"><img src="%s/32.png" width=32 height=32><img src="%s/16.png" width=16 height=16><span>128 · 32 · 16 px</span></div></div>' "$1" "$d" "$d" "$d"; }
  cols+="<div class=col><h2>$label</h2><div class=hero><img src=\"$d/1024.png\" width=1024 height=1024></div>$(desk dark)$(desk light)</div>"
done

cat > "$work/sheet.html" <<EOF
<html><head><style>
body{margin:0;background:#0E0E10;font:500 26px -apple-system,system-ui;color:#EDEDF0;display:flex;gap:24px;padding:32px}
.col{width:1024px;display:flex;flex-direction:column;gap:20px}
h2{font-size:34px;font-weight:600;margin:4px 0;color:#FF8A3D;letter-spacing:-.3px}
.hero{background:#232327;border-radius:28px}
.hero img{display:block}
.desk{border-radius:28px;height:230px;display:flex;align-items:center;justify-content:center;gap:56px}
.dark{background:radial-gradient(120% 90% at 30% 0%,#3a3550 0%,#161820 60%,#0b0c10 100%)}
.light{background:radial-gradient(120% 90% at 30% 0%,#fdf3e7 0%,#dfe4ef 60%,#c9cfdc 100%);color:#333}
.dock{display:flex;align-items:center;gap:6px;padding:6px 14px;border-radius:40px;background:rgba(255,255,255,.16);box-shadow:inset 0 0 0 1px rgba(255,255,255,.22),0 10px 30px rgba(0,0,0,.25)}
.light .dock{background:rgba(255,255,255,.5)}
.nb{width:100px;height:100px;margin:14px;border-radius:23px;background:linear-gradient(#f4f4f6,#d9d9de)}
.dark .nb{background:linear-gradient(#3b3b42,#202024)}
.sizes{display:flex;align-items:center;gap:28px}
.sizes span{font-size:20px;opacity:.6}
</style></head><body>$cols</body></html>
EOF
w=$(( 1048 * $# + 40 ))
prof=$(mktemp -d -t iconchrome); log="$work/chrome.log"; rm -f "$out"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --user-data-dir="$prof" --force-device-scale-factor=1 --allow-file-access-from-files \
  --window-size="$w,1640" --screenshot="$out" "file://$work/sheet.html" >"$log" 2>&1 &
pid=$!
for _ in $(seq 1 200); do [ -s "$out" ] && break; kill -0 $pid 2>/dev/null || break; sleep 0.2; done
sleep 0.3; kill $pid 2>/dev/null || true; wait $pid 2>/dev/null || true
[ -s "$out" ] || { echo "sheet render failed" >&2; tail -20 "$log" >&2; exit 1; }
rm -rf "$prof" "$work"
echo "$out"
