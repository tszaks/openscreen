#!/usr/bin/env python3
"""Print the SVG path for the macOS app-icon body: a superellipse (n=5)
filling the 824px grid square at (100,100) on the 1024 canvas."""
import math, sys
n, size, off, steps = 5.0, 824.0, 100.0, 256
h = size / 2
pts = []
for i in range(steps):
    t = 2 * math.pi * i / steps
    c, s = math.cos(t), math.sin(t)
    x = math.copysign(abs(c) ** (2 / n), c) * h + off + h
    y = math.copysign(abs(s) ** (2 / n), s) * h + off + h
    pts.append(f"{x:.1f} {y:.1f}")
sys.stdout.write("M" + " L".join(pts) + "Z\n")
