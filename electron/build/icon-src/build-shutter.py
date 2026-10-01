#!/usr/bin/env python3
"""Writes the shutter-*.svg concepts (round 2: camera iris).

Every iris here is built from real geometry, not drawn by hand. Each blade's
inner edge is an arc of a large circle C_i that just touches the opening; the
blades are rotated copies, and each one is overlapped by the next, so blade i
shows only the part of the disc that is outside C_i and still inside C_(i+1).
That is how a real diaphragm stacks, and it keeps the overlaps consistent all
the way round (the last blade tucks under the first).

Run from anywhere: python3 build-shutter.py
"""
import math
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
SQ = subprocess.check_output(["python3", os.path.join(HERE, "squircle.py")], text=True).strip()
CX = CY = 512.0
ORANGE = "#FF8A3D"


def f(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


def pt(p):
    return f"{f(p[0])} {f(p[1])}"


def circle_hits(c0, r0, c1, r1):
    dx, dy = c1[0] - c0[0], c1[1] - c0[1]
    d = math.hypot(dx, dy)
    a = (r0 * r0 - r1 * r1 + d * d) / (2 * d)
    h = math.sqrt(max(r0 * r0 - a * a, 0.0))
    mx, my = c0[0] + a * dx / d, c0[1] + a * dy / d
    return [(mx + h * dy / d, my - h * dx / d), (mx - h * dy / d, my + h * dx / d)]


def arc(p_from, p_to, c, r):
    a0 = math.atan2(p_from[1] - c[1], p_from[0] - c[0])
    a1 = math.atan2(p_to[1] - c[1], p_to[0] - c[0])
    d = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
    return f"A{f(r)} {f(r)} 0 0 {1 if d > 0 else 0} {pt(p_to)}"


class Iris:
    """n blades in a disc of radius R; the opening touches radius r.
    rho is the curvature radius of each blade edge (bigger = straighter).
    rot turns the whole iris; dists lets alternate blades sit farther out,
    which is how the play-triangle opening is made."""

    def __init__(self, n, R, r, rho, rot=-90.0, dists=None):
        self.n, self.R = n, R
        self.circ = []
        for i in range(n):
            th = math.radians(rot + 360.0 * i / n)
            nx, ny = math.cos(th), math.sin(th)
            ri = dists[i] if dists else r
            T = (CX + ri * nx, CY + ri * ny)
            c = (T[0] - rho * nx, T[1] - rho * ny)
            self.circ.append((c, rho, T, (-ny, nx)))
        # rim point of C_i on its trailing side, and vertex between C_i and C_(i+1)
        self.rim, self.vert = [], []
        for i in range(n):
            c, rho_, T, t = self.circ[i]
            hits = circle_hits(c, rho_, (CX, CY), R)
            self.rim.append(min(hits, key=lambda p: (p[0] - T[0]) * t[0] + (p[1] - T[1]) * t[1]))
            c2, rho2, _, _ = self.circ[(i + 1) % n]
            hits = circle_hits(c, rho_, c2, rho2)
            self.vert.append(min(hits, key=lambda p: math.hypot(p[0] - CX, p[1] - CY)))

    def blade(self, i):
        """Visible part of blade i."""
        n = self.n
        c, rho, _, _ = self.circ[i]
        c2, rho2, _, _ = self.circ[(i + 1) % n]
        Ri, Vp, Vi, Rn = self.rim[i], self.vert[(i - 1) % n], self.vert[i], self.rim[(i + 1) % n]
        return (f"M{pt(Ri)} {arc(Ri, Vp, c, rho)} {arc(Vp, Vi, c, rho)} "
                f"{arc(Vi, Rn, c2, rho2)} {arc(Rn, Ri, (CX, CY), self.R)}Z")

    def edge(self, i):
        """Blade i's own exposed edge: where it lies on top of blade i-1, then the opening."""
        c, rho, _, _ = self.circ[i]
        Ri, Vp, Vi = self.rim[i], self.vert[(i - 1) % self.n], self.vert[i]
        return f"M{pt(Ri)} {arc(Ri, Vp, c, rho)} {arc(Vp, Vi, c, rho)}"

    def opening(self):
        n, d = self.n, ""
        for i in range(n):
            c, rho, _, _ = self.circ[(i + 1) % n]
            a, b = self.vert[i], self.vert[(i + 1) % n]
            d += (f"M{pt(a)} " if i == 0 else "") + arc(a, b, c, rho) + " "
        return d + "Z"

    def heading(self, i):
        """Angle (rad) from the centre to the middle of blade i's rim arc."""
        a = self.rim[i]
        b = self.rim[(i + 1) % self.n]
        return math.atan2((a[1] + b[1]) / 2 - CY, (a[0] + b[0]) / 2 - CX)


def mix(c0, c1, t):
    a = [int(c0[k:k + 2], 16) for k in (1, 3, 5)]
    b = [int(c1[k:k + 2], 16) for k in (1, 3, 5)]
    return "#" + "".join(f"{round(x + (y - x) * t):02X}" for x, y in zip(a, b))


def toplight(ang):
    """0 for a blade facing straight down, 1 for straight up (light from above)."""
    return (1 - math.sin(ang)) / 2


# ---------- shared tile ----------

BLURS = """
    <filter id="blur6" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="6"/></filter>
    <filter id="blur14" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="14"/></filter>
    <filter id="blur30" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="30"/></filter>"""


def tile_defs(top, mid, bot, sheen=0.09):
    return f"""
    <path id="sq" d="{SQ}"/>
    <clipPath id="clip"><use href="#sq"/></clipPath>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#000" flood-opacity="0.28"/>
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000" flood-opacity="0.30"/>
    </filter>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{top}"/><stop offset="0.55" stop-color="{mid}"/><stop offset="1" stop-color="{bot}"/>
    </linearGradient>
    <radialGradient id="sheen" cx="0.5" cy="0" r="0.8">
      <stop offset="0" stop-color="#fff" stop-opacity="{sheen}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.40"/><stop offset="0.12" stop-color="#fff" stop-opacity="0.05"/>
      <stop offset="0.85" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="0.08"/>
    </linearGradient>"""+BLURS


TILE = """  <use href="#sq" fill="url(#tile)" filter="url(#shadow)"/>
  <use href="#sq" fill="url(#sheen)"/>"""
RIM = '  <use href="#sq" fill="none" stroke="url(#rim)" stroke-width="3" clip-path="url(#clip)"/>'


def svg(comment, defs, body):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">\n'
            f"  <!-- {comment} -->\n  <defs>{defs}\n  </defs>\n{TILE}\n  <g clip-path=\"url(#clip)\">\n{body}\n  </g>\n{RIM}\n</svg>\n")


def barrel(R_out, R_in, top, bot, name="barrel"):
    """A machined ring that holds the blades: a soft gradient body, a lit top lip
    and a dark seat where the blades disappear under it."""
    defs = f"""
    <linearGradient id="{name}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{top}"/><stop offset="0.5" stop-color="{mix(top, bot, 0.6)}"/><stop offset="1" stop-color="{bot}"/>
    </linearGradient>
    <linearGradient id="{name}Lip" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="0.45" stop-color="#fff" stop-opacity="0"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0.16"/>
    </linearGradient>
    <mask id="{name}Hole"><rect width="1024" height="1024" fill="#fff"/><circle cx="512" cy="512" r="{f(R_in)}" fill="#000"/></mask>"""
    under = (f'    <circle cx="512" cy="{f(CY + 16)}" r="{f(R_out + 6)}" fill="#000" opacity="0.45" filter="url(#blur14)"/>')
    over = (f'    <circle cx="512" cy="512" r="{f(R_out)}" fill="url(#{name})" mask="url(#{name}Hole)"/>\n'
            f'    <circle cx="512" cy="512" r="{f(R_out - 1.5)}" fill="none" stroke="url(#{name}Lip)" stroke-width="3"/>\n'
            f'    <circle cx="512" cy="512" r="{f(R_in + 1)}" fill="none" stroke="#000" stroke-opacity="0.55" stroke-width="3"/>')
    return defs, under, over


def iris_layers(iris, shade, pid, shadow=0.55, edge_light=0.5, shadow_dy=7, vignette=0.35):
    """Blades with: per-blade gradient lit from above, a soft shadow cast by the
    blade on top, and a thin specular along each blade's own edge."""
    defs, body = "", ""
    n = iris.n
    for i in range(n):
        defs += f'\n    <clipPath id="{pid}b{i}"><path d="{iris.blade(i)}"/></clipPath>'
    for i in range(n):
        ang = iris.heading(i)
        lo, hi = shade(toplight(ang))
        # gradient runs across the blade from its exposed edge to the covered edge
        a, b = iris.vert[i], iris.rim[(i + 1) % n]
        e = iris.rim[i]
        gx1, gy1 = (a[0] + e[0]) / 2, (a[1] + e[1]) / 2
        gx2, gy2 = b
        defs += (f'\n    <linearGradient id="{pid}g{i}" gradientUnits="userSpaceOnUse" x1="{f(gx1)}" y1="{f(gy1)}" x2="{f(gx2)}" y2="{f(gy2)}">'
                 f'<stop offset="0" stop-color="{hi}"/><stop offset="1" stop-color="{lo}"/></linearGradient>')
        nxt = (i + 1) % n
        body += (f'    <path d="{iris.blade(i)}" fill="url(#{pid}g{i})"/>\n'
                 f'    <g clip-path="url(#{pid}b{i})"><path d="{iris.blade(nxt)}" transform="translate(0 {shadow_dy})" fill="#000" opacity="{shadow}" filter="url(#blur14)"/></g>\n')
    for i in range(n):
        lit = edge_light * (0.35 + 0.65 * toplight(iris.heading(i)))
        body += (f'    <path d="{iris.edge(i)}" fill="none" stroke="#fff" stroke-opacity="{f(lit)}" stroke-width="2.5" '
                 f'stroke-linecap="round" clip-path="url(#{pid}b{i})"/>\n')
    # the blades run under the ring, so they fall into shade toward the rim
    defs += (f'\n    <radialGradient id="{pid}vig" cx="0.5" cy="0.5" r="0.5"><stop offset="0.55" stop-color="#000" stop-opacity="0"/>'
             f'<stop offset="1" stop-color="#000" stop-opacity="{vignette}"/></radialGradient>')
    body += f'    <circle cx="512" cy="512" r="{f(iris.R)}" fill="url(#{pid}vig)"/>\n'
    return defs, body


def opening_well(iris, inner, outer, oid="open", glow=None, depth=0.75, width=40, mid=None):
    """The hole in the middle: a radial fill plus an inner shadow under the blade edges."""
    d = iris.opening()
    defs = (f'\n    <radialGradient id="{oid}Fill" cx="0.5" cy="0.42" r="0.6"><stop offset="0" stop-color="{inner}"/>'
            + (f'<stop offset="0.45" stop-color="{mid}"/>' if mid else "") +
            f'<stop offset="1" stop-color="{outer}"/></radialGradient>'
            f'\n    <clipPath id="{oid}Clip"><path d="{d}"/></clipPath>')
    body = f'    <path d="{d}" fill="url(#{oid}Fill)"/>\n'
    if glow:
        body += f'    <path d="{d}" fill="{glow}" opacity="0.6" filter="url(#blur30)"/>\n'
    body += (f'    <g clip-path="url(#{oid}Clip)"><path d="{d}" fill="none" stroke="#000" stroke-opacity="{depth}" '
             f'stroke-width="{width}" transform="translate(0 10)" filter="url(#blur14)"/></g>\n')
    return defs, body


def lens_glass(iris, oid="lens"):
    """Coated glass seen through a dark opening: a faint warm ring and a soft sheen from above."""
    d = iris.opening()
    return (f'\n    <clipPath id="{oid}Clip"><path d="{d}"/></clipPath>'
            f'\n    <radialGradient id="{oid}Sheen" cx="0.3" cy="0.22" r="0.55"><stop offset="0" stop-color="#fff" stop-opacity="0.26"/>'
            f'<stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>',
            f'    <g clip-path="url(#{oid}Clip)">\n'
            f'      <circle cx="512" cy="512" r="82" fill="none" stroke="#FF8A3D" stroke-opacity="0.16" stroke-width="8" filter="url(#blur6)"/>\n'
            f'      <circle cx="512" cy="512" r="130" fill="url(#{oid}Sheen)"/>\n'
            f'    </g>\n')


def write(name, text):
    with open(os.path.join(HERE, name), "w") as fh:
        fh.write(text)
    print("wrote", name)


# ---------- A: Graphite iris, ember core ----------

def concept_a(small=False):
    n = 6 if small else 7
    iris = Iris(n, R=300, r=150 if small else 132, rho=560)
    bd, under, over = barrel(332, 292, "#6E6E78", "#1E1E22")
    graphite = lambda k: (mix("#141417", "#2C2C32", k), mix("#3A3A42", "#8A8A95", k))
    ld, lb = iris_layers(iris, graphite, "a", shadow=0.7, edge_light=0 if small else 0.55)
    od, ob = opening_well(iris, "#FFF1E2", "#E85E18", glow="#FF8A3D", mid="#FFA25E", depth=0.4 if small else 0.75)
    defs = tile_defs("#2E2E34", "#18181B", "#0E0E10") + bd + ld + od
    body = under + "\n" + lb + ob + over
    return svg("OpenScreen shutter concept A: a graphite iris opening onto warm orange light.", defs, body)


# ---------- B: Ember iris ----------

EMBER = lambda k: (mix("#CC4E16", "#EC6C24", k), mix("#FF9A55", "#FFC594", k))


def concept_b(small=False):
    n = 6 if small else 7
    iris = Iris(n, R=324 if small else 312, r=150 if small else 118, rho=560)
    bd, under, over = barrel(340, 320, "#4A4A52", "#151518") if small else barrel(336, 306, "#4A4A52", "#151518")
    ld, lb = iris_layers(iris, EMBER, "b", shadow=0.6 if small else 0.45, edge_light=0 if small else 0.7,
                         vignette=0.2 if small else 0.35)
    od, ob = opening_well(iris, "#2E2B2C", "#0A0A0C")
    gd, gb = lens_glass(iris) if not small else ("", "")
    defs = tile_defs("#2E2E34", "#18181B", "#0E0E10") + bd + ld + od + gd
    body = under + "\n" + lb + ob + gb + over
    return svg("OpenScreen shutter concept B: orange iris blades around a dark lens.", defs, body)


# ---------- C: Play iris ----------

def concept_c(small=False):
    # Six blades; the three that point at the centre close to a triangle and the
    # other three stop short, trimming its corners. The opening becomes Play.
    near, far = (142, 224) if small else (122, 186)
    iris = Iris(6, R=300, r=near, rho=900, rot=180, dists=[near, far] * 3)
    bd, under, over = barrel(332, 292, "#6E6E78", "#1E1E22")
    graphite = lambda k: (mix("#141417", "#2C2C32", k), mix("#3A3A42", "#8A8A95", k))
    ld, lb = iris_layers(iris, graphite, "c", shadow=0.7, edge_light=0 if small else 0.55)
    od, ob = opening_well(iris, "#FFF1E2", "#E85E18", glow="#FF8A3D", mid="#FFA25E", depth=0.35 if small else 0.7)
    defs = tile_defs("#2E2E34", "#18181B", "#0E0E10") + bd + ld + od
    body = under + "\n" + lb + ob + over
    return svg("OpenScreen shutter concept C: iris blades closing to a glowing Play triangle.", defs, body)


# ---------- D: Orange tile, graphite iris ----------

def concept_d(small=False):
    n = 6 if small else 8
    iris = Iris(n, R=318, r=150 if small else 128, rho=620)
    graphite = lambda k: (mix("#17171A", "#26262B", k), mix("#33333A", "#6C6C76", k))
    ld, lb = iris_layers(iris, graphite, "d", shadow=0.6, edge_light=0 if small else 0.5)
    od, ob = opening_well(iris, "#FFF6EE", "#FFB884", depth=0.4, width=22)
    seat = ('    <circle cx="512" cy="530" r="330" fill="#7A2E06" opacity="0.55" filter="url(#blur30)"/>\n'
            '    <circle cx="512" cy="512" r="322" fill="#101012"/>\n')
    lip = ('    <circle cx="512" cy="512" r="320.5" fill="none" stroke="url(#dLip)" stroke-width="3"/>\n')
    defs = (tile_defs("#FFAA6B", "#FF8A3D", "#EE6A1C", sheen=0.25) + ld + od +
            '\n    <linearGradient id="dLip" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.15"/>'
            '<stop offset="1" stop-color="#fff" stop-opacity="0.45"/></linearGradient>')
    body = seat + lb + ob + lip
    return svg("OpenScreen shutter concept D: a graphite iris set into an orange tile.", defs, body)


# B as Icon Composer layers. Icon Composer's canvas is the squircle itself, so
# each layer views just the 824 px body; the system adds the tile, the glass,
# the shadows and the dark, tinted and clear looks.

def concept_b_layers():
    iris = Iris(7, R=312, r=118, rho=560)
    bd, under, over = barrel(336, 306, "#4A4A52", "#151518")
    ld, lb = iris_layers(iris, EMBER, "b", shadow=0.45, edge_light=0.7)
    od, ob = opening_well(iris, "#2E2B2C", "#0A0A0C")
    gd, gb = lens_glass(iris)

    def layer(defs, body):
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="100 100 824 824" width="1024" height="1024">\n'
                f'  <defs>{BLURS}{defs}\n  </defs>\n{body}</svg>\n')
    return {"ring.svg": layer(bd, over + "\n"), "blades.svg": layer(ld, lb), "lens.svg": layer(od + gd, ob + gb)}


for key, fn in (("a-graphite-iris", concept_a), ("b-ember-iris", concept_b),
                ("c-play-iris", concept_c), ("d-orange-tile", concept_d)):
    write(f"shutter-{key}.svg", fn())
    write(f"shutter-{key}-small.svg", fn(small=True))

icon_dir = os.path.join(HERE, "OpenScreen.icon", "Assets")
os.makedirs(icon_dir, exist_ok=True)
for name, text in concept_b_layers().items():
    write(os.path.join("OpenScreen.icon", "Assets", name), text)
