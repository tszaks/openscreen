#!/bin/bash
# Regenerates the concept-*.svg files. The shared tile (squircle body, shadow,
# glass lighting) is written once here; each concept's artwork follows.
set -euo pipefail
cd "$(dirname "$0")"
P=$(python3 squircle.py)

DEFS=$(cat <<EOF
    <path id="sq" d="$P"/>
    <clipPath id="clip"><use href="#sq"/></clipPath>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#000" flood-opacity="0.28"/>
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000" flood-opacity="0.30"/>
    </filter>
    <filter id="grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7"/>
      <feColorMatrix type="matrix" values="1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 0 0.05"/>
    </filter>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2E2E34"/>
      <stop offset="0.55" stop-color="#18181B"/>
      <stop offset="1" stop-color="#0E0E10"/>
    </linearGradient>
    <radialGradient id="sheen" cx="0.5" cy="0" r="0.8">
      <stop offset="0" stop-color="#fff" stop-opacity="0.09"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.38"/>
      <stop offset="0.12" stop-color="#fff" stop-opacity="0.05"/>
      <stop offset="0.85" stop-color="#fff" stop-opacity="0"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0.07"/>
    </linearGradient>
EOF
)
TILE=$(cat <<'EOF'
  <use href="#sq" fill="url(#tile)" filter="url(#shadow)"/>
  <g clip-path="url(#clip)"><rect x="100" y="100" width="824" height="824" filter="url(#grain)"/></g>
  <use href="#sq" fill="url(#sheen)"/>
EOF
)
RIM='  <use href="#sq" fill="none" stroke="url(#rim)" stroke-width="3" clip-path="url(#clip)"/>'
OPEN='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">'

# ---------- A: Aperture + record ----------
cat > concept-a-aperture.svg <<EOF
$OPEN
  <!-- OpenScreen concept A: a machined lens ring holding a glowing record dot. -->
  <defs>
$DEFS
    <linearGradient id="bezel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5C5C65"/>
      <stop offset="0.5" stop-color="#2E2E34"/>
      <stop offset="1" stop-color="#1D1D21"/>
    </linearGradient>
    <linearGradient id="bezelEdge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.45"/>
      <stop offset="0.5" stop-color="#fff" stop-opacity="0"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0.10"/>
    </linearGradient>
    <radialGradient id="well" cx="0.5" cy="0.62" r="0.6">
      <stop offset="0" stop-color="#2A1A10"/>
      <stop offset="1" stop-color="#060607"/>
    </radialGradient>
    <radialGradient id="dot" cx="0.5" cy="0.25" r="0.85">
      <stop offset="0" stop-color="#FFB27A"/>
      <stop offset="0.5" stop-color="#FF8A3D"/>
      <stop offset="1" stop-color="#E4601F"/>
    </radialGradient>
    <linearGradient id="dotSpec" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.34"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="30"/>
    </filter>
  </defs>
$TILE
  <g clip-path="url(#clip)">
    <circle cx="512" cy="512" r="266" fill="url(#bezel)"/>
    <circle cx="512" cy="512" r="264.5" fill="none" stroke="url(#bezelEdge)" stroke-width="3"/>
    <circle cx="512" cy="512" r="204" fill="url(#well)"/>
    <circle cx="512" cy="512" r="204" fill="none" stroke="#000" stroke-opacity="0.55" stroke-width="5"/>
    <circle cx="512" cy="522" r="148" fill="#FF7A2A" opacity="0.5" filter="url(#glow)"/>
    <circle cx="512" cy="512" r="146" fill="url(#dot)"/>
    <path d="M388 470 A146 146 0 0 1 636 470 A170 120 0 0 0 388 470 Z" fill="url(#dotSpec)"/>
  </g>
$RIM
</svg>
EOF

# ---------- B: Phone + zoom ----------
cat > concept-b-phone-zoom.svg <<EOF
$OPEN
  <!-- OpenScreen concept B: a phone, and a loupe blowing up the tap it is demoing. -->
  <defs>
$DEFS
    <linearGradient id="frame" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#A4A4AD"/>
      <stop offset="1" stop-color="#55555C"/>
    </linearGradient>
    <linearGradient id="screen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#26262C"/>
      <stop offset="1" stop-color="#3A2A20"/>
    </linearGradient>
    <radialGradient id="tap" cx="0.5" cy="0.3" r="0.8">
      <stop offset="0" stop-color="#FFB27A"/>
      <stop offset="0.55" stop-color="#FF8A3D"/>
      <stop offset="1" stop-color="#E4601F"/>
    </radialGradient>
    <linearGradient id="loupeRim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#C4C4CA"/>
    </linearGradient>
    <clipPath id="lens"><circle cx="652" cy="652" r="170"/></clipPath>
    <filter id="lift" x="-30%" y="-30%" width="160%" height="170%">
      <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity="0.6"/>
    </filter>
    <g id="scene">
      <rect x="236" y="188" width="340" height="648" rx="84" fill="url(#frame)"/>
      <rect x="254" y="206" width="304" height="612" rx="66" fill="url(#screen)"/>
      <rect x="366" y="226" width="80" height="26" rx="13" fill="#050506"/>
      <rect x="292" y="450" width="200" height="56" rx="28" fill="#fff" fill-opacity="0.14"/>
      <circle cx="392" cy="478" r="36" fill="#FF8A3D" fill-opacity="0.25"/>
      <circle cx="392" cy="478" r="20" fill="url(#tap)"/>
    </g>
  </defs>
$TILE
  <g clip-path="url(#clip)">
    <use href="#scene"/>
    <circle cx="652" cy="652" r="192" fill="url(#loupeRim)" filter="url(#lift)"/>
    <circle cx="652" cy="652" r="170" fill="#1E1E23"/>
    <g clip-path="url(#lens)">
      <use href="#scene" transform="translate(652 652) scale(2.5) translate(-392 -478)"/>
      <circle cx="652" cy="652" r="170" fill="url(#sheen)"/>
    </g>
    <circle cx="652" cy="652" r="170" fill="none" stroke="#000" stroke-opacity="0.3" stroke-width="4"/>
  </g>
$RIM
</svg>
EOF

# B at 16/32 px: the loupe turns to mush, so the small sizes keep only the
# phone and its tap. make-icns.sh picks up any <name>-small.svg automatically.
cat > concept-b-phone-zoom-small.svg <<EOF
$OPEN
  <!-- OpenScreen concept B, small-size artwork (16 and 32 px). -->
  <defs>
$DEFS
    <linearGradient id="frame" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#B4B4BC"/>
      <stop offset="1" stop-color="#5C5C63"/>
    </linearGradient>
    <radialGradient id="tap" cx="0.5" cy="0.3" r="0.8">
      <stop offset="0" stop-color="#FFB27A"/>
      <stop offset="0.55" stop-color="#FF8A3D"/>
      <stop offset="1" stop-color="#E4601F"/>
    </radialGradient>
  </defs>
$TILE
  <g clip-path="url(#clip)">
    <rect x="322" y="176" width="380" height="672" rx="96" fill="url(#frame)"/>
    <rect x="352" y="206" width="320" height="612" rx="68" fill="#202025"/>
    <circle cx="512" cy="560" r="112" fill="url(#tap)"/>
  </g>
$RIM
</svg>
EOF

# ---------- C: Open screen ----------
cat > concept-c-open-screen.svg <<EOF
$OPEN
  <!-- OpenScreen concept C: a screen swinging open like a door onto warm light. -->
  <defs>
$DEFS
    <linearGradient id="light" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFF6EE"/>
      <stop offset="0.55" stop-color="#FFB47E"/>
      <stop offset="1" stop-color="#FF8A3D"/>
    </linearGradient>
    <linearGradient id="door" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#1A1A1E"/>
      <stop offset="1" stop-color="#34343B"/>
    </linearGradient>
    <linearGradient id="frameC" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4C4C54"/>
      <stop offset="1" stop-color="#202024"/>
    </linearGradient>
    <linearGradient id="beam" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FF9A52" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#FF8A3D" stop-opacity="0"/>
    </linearGradient>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="10"/>
    </filter>
    <filter id="doorShadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="10" dy="0" stdDeviation="14" flood-color="#000" flood-opacity="0.45"/>
    </filter>
  </defs>
$TILE
  <g clip-path="url(#clip)">
    <path d="M300 720 L724 720 L860 924 L164 924 Z" fill="url(#beam)" filter="url(#soft)"/>
    <rect x="256" y="236" width="512" height="484" rx="56" fill="url(#frameC)"/>
    <rect x="280" y="260" width="464" height="436" rx="36" fill="url(#light)"/>
    <path d="M280 296 Q280 260 316 260 L486 314 Q496 317 496 328 L496 628 Q496 639 486 642 L316 696 Q280 696 280 660 Z" fill="url(#door)" filter="url(#doorShadow)"/>
    <path d="M486 314 Q496 317 496 328 L496 628 Q496 639 486 642" fill="none" stroke="#FFD2AE" stroke-opacity="0.8" stroke-width="4"/>
    <circle cx="462" cy="478" r="9" fill="#FFB27A" opacity="0.9"/>
    <rect x="256" y="236" width="512" height="484" rx="56" fill="none" stroke="#fff" stroke-opacity="0.14" stroke-width="3"/>
  </g>
$RIM
</svg>
EOF

# ---------- D: Tap ripple ----------
cat > concept-d-tap-ripple.svg <<EOF
$OPEN
  <!-- OpenScreen concept D: a touch point sending ripples across dark glass. -->
  <defs>
$DEFS
    <radialGradient id="core" cx="0.5" cy="0.28" r="0.85">
      <stop offset="0" stop-color="#FFD4B2"/>
      <stop offset="0.45" stop-color="#FF8A3D"/>
      <stop offset="1" stop-color="#E4601F"/>
    </radialGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFB27A"/>
      <stop offset="1" stop-color="#FF7A2A"/>
    </linearGradient>
    <filter id="glowD" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="28"/>
    </filter>
  </defs>
$TILE
  <g clip-path="url(#clip)">
    <circle cx="512" cy="512" r="324" fill="none" stroke="url(#ring)" stroke-opacity="0.2" stroke-width="22"/>
    <circle cx="512" cy="512" r="240" fill="none" stroke="url(#ring)" stroke-opacity="0.5" stroke-width="32"/>
    <circle cx="512" cy="512" r="148" fill="none" stroke="url(#ring)" stroke-opacity="0.92" stroke-width="42"/>
    <circle cx="512" cy="522" r="84" fill="#FF7A2A" opacity="0.4" filter="url(#glowD)"/>
    <circle cx="512" cy="512" r="80" fill="url(#core)"/>
  </g>
$RIM
</svg>
EOF
# D at 16/32 px: the outer ripples blur into a haze, so keep one bold ring.
cat > concept-d-tap-ripple-small.svg <<EOF
$OPEN
  <!-- OpenScreen concept D, small-size artwork (16 and 32 px). -->
  <defs>
$DEFS
    <radialGradient id="core" cx="0.5" cy="0.28" r="0.85">
      <stop offset="0" stop-color="#FFD4B2"/>
      <stop offset="0.45" stop-color="#FF8A3D"/>
      <stop offset="1" stop-color="#E4601F"/>
    </radialGradient>
  </defs>
$TILE
  <g clip-path="url(#clip)">
    <circle cx="512" cy="512" r="262" fill="none" stroke="#FF8A3D" stroke-opacity="0.7" stroke-width="64"/>
    <circle cx="512" cy="512" r="132" fill="url(#core)"/>
  </g>
$RIM
</svg>
EOF
ls concept-*.svg
