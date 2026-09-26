#!/bin/bash
# compare-sheet.sh <out.png> <icon1.svg|png> [icon2 ...]
# Builds a side-by-side review sheet: hero, a Dock mock (dark + light desktop)
# with placeholder neighbours, and true-pixel 64/32/16 sizes. Label = file stem.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=$1; shift
work=$(mktemp -d -t iconsheet)
P=$(python3 "$here/squircle.py")

# Placeholder neighbours: plain shapes on the same squircle, not real app icons.
nb() { # name, tile-fill defs, artwork
  cat > "$work/$1.svg" <<EOF
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs>
<filter id="s" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-opacity="0.28"/><feDropShadow dx="0" dy="14" stdDeviation="16" flood-opacity="0.3"/></filter>
<clipPath id="c"><path d="$P"/></clipPath>$2</defs>
<path d="$P" fill="url(#t)" filter="url(#s)"/><g clip-path="url(#c)">$3</g></svg>
EOF
}
nb folder '<linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6CC4FF"/><stop offset="1" stop-color="#1E7BE0"/></linearGradient>' \
  '<rect x="512" y="100" width="412" height="824" fill="#F2F4F8"/><circle cx="380" cy="420" r="30" fill="#0B2A4A"/><circle cx="650" cy="420" r="30" fill="#0B2A4A"/><path d="M330 640 Q512 760 700 640" stroke="#0B2A4A" stroke-width="34" fill="none" stroke-linecap="round"/>'
nb compass '<linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#E4E6EA"/></linearGradient><linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3FB6FF"/><stop offset="1" stop-color="#1467E0"/></linearGradient>' \
  '<circle cx="512" cy="512" r="330" fill="url(#b)"/><path d="M512 250 L570 512 L512 774 L454 512 Z" fill="#fff" transform="rotate(45 512 512)"/><path d="M512 250 L570 512 L454 512 Z" fill="#FF3B30" transform="rotate(45 512 512)"/>'
nb bubble '<linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6BEA7C"/><stop offset="1" stop-color="#16B33A"/></linearGradient>' \
  '<ellipse cx="512" cy="490" rx="300" ry="250" fill="#fff"/><path d="M300 640 L250 760 L420 690 Z" fill="#fff"/>'
nb notes '<linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#EDEDED"/></linearGradient>' \
  '<rect x="100" y="100" width="824" height="230" fill="#FFCF3A"/><g stroke="#C9C9CC" stroke-width="14"><line x1="180" y1="470" x2="844" y2="470"/><line x1="180" y1="600" x2="844" y2="600"/><line x1="180" y1="730" x2="844" y2="730"/></g>'

cols=""
for f in "$@"; do
  abs=$(cd "$(dirname "$f")" && pwd)/$(basename "$f")
  label=$(basename "${f%.*}")
  dock() { printf '<div class="dock"><img src="%s" width=128 height=128><img src="%s" width=128 height=128><img src="%s" width=128 height=128 class="me"><img src="%s" width=128 height=128></div>' "$work/folder.svg" "$work/compass.svg" "$abs" "$work/bubble.svg"; }
  small=$abs; [ -f "${abs%.svg}-small.svg" ] && small=${abs%.svg}-small.svg  # same rule as make-icns.sh
  sizes() { printf '<div class="sizes"><img src="%s" width=64 height=64><img src="%s" width=32 height=32><img src="%s" width=16 height=16></div>' "$abs" "$small" "$small"; }
  cols+="<div class=col><h2>$label</h2><div class=hero><img src=\"$abs\" width=300 height=300></div>"
  cols+="<div class='desk dark'>$(dock)$(sizes)</div><div class='desk light'>$(dock)$(sizes)</div></div>"
done
cat > "$work/sheet.html" <<EOF
<html><head><style>
body{margin:0;background:#0E0E10;font:500 20px -apple-system,system-ui;color:#EDEDF0;display:flex;gap:0;padding:24px}
.col{width:620px;display:flex;flex-direction:column;gap:14px;padding:0 10px}
h2{font-size:22px;font-weight:600;margin:6px 0;color:#FF8A3D;letter-spacing:-.2px}
.hero{background:#232327;border-radius:22px;height:340px;display:flex;align-items:center;justify-content:center}
.desk{border-radius:22px;padding:18px 16px 16px;display:flex;flex-direction:column;align-items:center;gap:16px}
.dark{background:radial-gradient(120% 90% at 30% 0%,#3a3550 0%,#161820 60%,#0b0c10 100%)}
.light{background:radial-gradient(120% 90% at 30% 0%,#fdf3e7 0%,#dfe4ef 60%,#c9cfdc 100%)}
.dock{display:flex;gap:2px;padding:4px 10px;border-radius:34px;background:rgba(255,255,255,.16);box-shadow:inset 0 0 0 1px rgba(255,255,255,.22),0 10px 30px rgba(0,0,0,.25)}
.light .dock{background:rgba(255,255,255,.45)}
.dock img{margin:-6px -4px}
.sizes{display:flex;align-items:center;gap:28px;height:70px}
</style></head><body>$cols</body></html>
EOF
w=$(( 640 * $# + 48 ))
prof=$(mktemp -d -t iconchrome); log="$work/chrome.log"; rm -f "$out"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --user-data-dir="$prof" --force-device-scale-factor=1 --allow-file-access-from-files \
  --window-size="$w,960" --screenshot="$out" "file://$work/sheet.html" >"$log" 2>&1 &
pid=$!
for _ in $(seq 1 150); do [ -s "$out" ] && break; kill -0 $pid 2>/dev/null || break; sleep 0.2; done
sleep 0.3; kill $pid 2>/dev/null || true; wait $pid 2>/dev/null || true
[ -s "$out" ] || { echo "sheet render failed" >&2; tail -20 "$log" >&2; exit 1; }
rm -rf "$prof" "$work"
echo "$out"
