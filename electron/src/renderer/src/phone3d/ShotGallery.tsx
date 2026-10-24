// The Shots section of the 3D tab: five tiles, each a small CSS 3D phone that
// plays the recipe from the shared pose math (expandShot + poseAt, the moves
// the shot op writes), plus the options the next inserted shot uses. Click a
// tile to insert at the playhead; Shift-click inserts it mirrored; hover plays
// it on the main preview without changing the project. With reduced motion
// the tiles hold one telling frame each.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FRONT, type Pose, type ShotRecipe } from '../../../shared/phone3d/model';
import { poseAt, withFloat } from '../../../shared/phone3d/pose';
import { defaultShotDuration, expandShot, INTENSITY_RANGE, SHOTS } from '../../../shared/phone3d/shots';
import { Switch } from '../ui';
import { GALLERY, RECIPE_LABEL } from './panelModel';
import { Track } from './Track';

/** One recipe's poses at 30 fps (float: one drift period). */
function shotPoses(recipe: ShotRecipe): Pose[] {
  if (recipe === 'float') {
    const float = { on: true, amount: 1, period: 3 };
    return Array.from({ length: 90 }, (_, j) => withFloat(FRONT, float, j / 30));
  }
  let n = 0;
  const transitions = expandShot(recipe, { start: 0 }, FRONT, () => `g${++n}`).transitions;
  const dur = SHOTS[recipe].duration;
  const p3 = { pose: { ...FRONT }, transitions };
  return Array.from({ length: Math.round(dur * 30) + 1 }, (_, j) => poseAt(p3, j / 30));
}

/** The frame a still tile holds (reduced motion): the moment that says what the shot does. */
const STILL_AT: Record<ShotRecipe, number> = { 'spin-in': 0.27, 'turn-to-back': 0.3, 'hero-layback': 0.4, settle: 0, float: 0.3 };

// CSS rotations: +tilt leans the top away (D12) = rotateX(+); turn = rotateY, as the engine renders.
const poseCss = (p: Pose) =>
  `translate(${(p.x * 40).toFixed(2)}px, ${(p.y * 62).toFixed(2)}px) rotateZ(${p.rotate.toFixed(2)}deg) rotateX(${p.tilt.toFixed(2)}deg) rotateY(${p.turn.toFixed(2)}deg) scale(${p.size.toFixed(3)})`;

function useReducedMotion() {
  const q = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [reduced, setReduced] = useState(q);
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

export interface ShotOptions {
  /** × the recipe's turn, 0.25..2 (the shot op's intensity). */
  strength: number;
  /** Seconds; null = each recipe's own length. */
  length: number | null;
  /** Return to front: 'front' (on) or 'stay' (off). */
  ret: 'front' | 'stay';
}

export function ShotGallery({
  options,
  onOptions,
  onInsert,
  onHover,
  finish,
  screen,
}: {
  options: ShotOptions;
  onOptions: (o: ShotOptions) => void;
  onInsert: (recipe: ShotRecipe, mirrored: boolean) => void;
  onHover: (recipe: ShotRecipe | null) => void;
  /** The device finish's colour, for the mini phones' backs. */
  finish: string;
  /** A small frame of the recording for the mini phones' screens. */
  screen?: string;
}) {
  const reduced = useReducedMotion();
  const poses = useMemo(() => Object.fromEntries(GALLERY.map((r) => [r, shotPoses(r)])) as Record<ShotRecipe, Pose[]>, []);
  const phones = useRef<Partial<Record<ShotRecipe, HTMLSpanElement | null>>>({});
  useEffect(() => {
    const place = (r: ShotRecipe, i: number) => {
      const el = phones.current[r];
      const a = poses[r];
      if (el) el.style.transform = poseCss(a[Math.min(i, a.length - 1)]);
    };
    if (reduced) {
      for (const r of GALLERY) place(r, Math.floor(poses[r].length * STILL_AT[r]));
      return;
    }
    let raf = 0;
    // Timed by the frame timestamps alone (no clock reads: this folder's determinism rule).
    let t0 = -1;
    const tick = (now: number) => {
      if (t0 < 0) t0 = now;
      const sec = Math.max(0, now - t0) / 1000;
      // Each tile plays its shot, holds 0.6 s, then plays again.
      for (const r of GALLERY) place(r, Math.floor(sec * 30) % (poses[r].length + 18));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced, poses]);

  return (
    <>
      <div className="shot-tiles">
        {GALLERY.map((r) => (
          <button
            key={r}
            type="button"
            className="shot-tile"
            title={`${RECIPE_LABEL[r]}${r === 'float' ? '' : ` · ${defaultShotDuration(r, options.ret).toFixed(1)} s`}. ${SHOTS[r].summary} Click to add at the playhead. Shift-click adds it mirrored.`}
            onClick={(e) => onInsert(r, e.shiftKey)}
            onMouseEnter={() => onHover(r)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(r)}
            onBlur={() => onHover(null)}
          >
            <span className="shot-stage" aria-hidden="true">
              <span className="mini-phone" style={{ '--finish': finish } as React.CSSProperties} ref={(el) => {
                  phones.current[r] = el;
                }}>
                <span className="face front" style={screen ? { backgroundImage: `url(${screen})` } : undefined} />
                <span className="face back" />
              </span>
            </span>
            <span className="shot-name">{RECIPE_LABEL[r]}</span>
          </button>
        ))}
      </div>
      {/* "Strength", not "Intensity": Intensity is the light's word on this tab. */}
      <div className="p3-pair">
        <Track
          label="Strength"
          value={Math.round(options.strength * 100)}
          unit="%"
          min={INTENSITY_RANGE[0] * 100}
          max={INTENSITY_RANGE[1] * 100}
          step={5}
          origin={100}
          title="How far a shot turns. 100% is the recipe as designed."
          onChange={(v) => onOptions({ ...options, strength: v / 100 })}
        />
        <Track
          label="Length"
          value={options.length ?? 0}
          unit="s"
          min={0}
          max={10}
          step={0.1}
          digits={1}
          placeholder={options.length === null ? 'Auto' : undefined}
          title="Empty (0) uses each shot's own length"
          onChange={(v) => onOptions({ ...options, length: v > 0 ? v : null })}
        />
      </div>
      <Switch label="Return to front" checked={options.ret === 'front'} onChange={(v) => onOptions({ ...options, ret: v ? 'front' : 'stay' })} />
    </>
  );
}
