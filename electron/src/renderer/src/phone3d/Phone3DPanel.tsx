// The 3D tab (SPEC §5.2, laid out as the approved mockups, revision 2).
//
// Three views:
// - home: the 3D phone switch and Auto 3D, warnings, Pose (with the target
//   chip that says what a change edits), Shots, then Look, Lighting, Shadow
//   & focus, Float and Export quality
// - one move selected: its name, the pinned Keyframe block (Start / End with
//   typeable times, Duration, the Easing pop-up and the curve popover), and
//   its Pose with Animate lighting / Animate focus
// - many moves selected: the same, with values that differ shown as "–"
//
// Every control's only write path is `apply3d` (D1): this file never calls
// setProj, and each gesture is one undo step (onBegin holds the history,
// onCommit seals it).

import React, { useLayoutEffect, useRef, useState } from 'react';
import type { ApplyContext, EditOp } from '../../../shared/agentOps';
import { LIGHT_PRESETS } from '../../../shared/phone3d/lighting';
import {
  defaultPhone3D,
  FRONT,
  LIGHT_PRESET_NAMES,
  POSE_RANGE,
  type Easing,
  type EasingName,
  type LightPreset,
  type Phone3D,
  type Pose,
  type PoseKey,
  type ShotRecipe,
} from '../../../shared/phone3d/model';
import { phone3dActive } from '../../../shared/phone3d/placement';
import { resolveStarts } from '../../../shared/phone3d/pose';
import type { Warning } from '../../../shared/phone3d/warnings';
import type { DirectStyle } from '../../../shared/phone3d/direct';
import type { Project } from '../../../shared/types';
import { Button, FormRow, Section, Segmented, Switch } from '../ui';
import { CurveGlyph, CurveThumb, TimingPopover } from './EasingCurve';
import {
  bezierFrom,
  chipFor,
  clock,
  durationBase,
  durationDragOps,
  durationOps,
  EASE_LABEL,
  EASE_MENU,
  EASE_PRESET,
  easingOps,
  fovForMm,
  inactiveText,
  isFitted,
  keyPoses,
  LENS_RANGE,
  lensMm,
  lockedOps,
  lockPose,
  minus,
  mixedChannels,
  moveName,
  multiPoseOps,
  nextKey,
  parseTime,
  phone3dAsOps,
  poseEditOps,
  prevKey,
  qualityHint,
  RECIPE_LABEL,
  samePart,
  shotLine,
  warningText,
  type Chip,
  type DurationBase,
  type PoseLock,
} from './panelModel';
import type { MenuItem, MenuSpec } from './PopupMenu';
import { ShotGallery, type ShotOptions } from './ShotGallery';
import { DerivedTrack, Track } from './Track';
import './phone3d.css';

/** Send ops through the editor's apply3d (one state change, one undo step); false when refused (a toast says why).
 *  `ids` seeds the ids new moves get, in order (a gesture that adds a move and then edits it). */
export type Apply3d = (ops: EditOp | EditOp[], opts?: { announce?: string | ((p: Project) => string); ctx?: Partial<ApplyContext>; ids?: string[] }) => boolean;

export interface AutoOptions {
  style: DirectStyle;
  keep: boolean;
  scenes: boolean;
}

export interface Phone3DPanelProps {
  proj: Project;
  apply3d: Apply3d;
  playhead: number;
  fps: number;
  /** Selected moves on the 3D lane (ids), and the keyframe the move view edits. */
  selected: string[];
  activeKey: 'start' | 'end';
  onSelect: (ids: string[], key?: 'start' | 'end') => void;
  onSeek: (t: number) => void;
  warnings: Warning[];
  /** The tap kind at an output time (warning words). */
  kindAt: (t: number) => string | null;
  /** Undo: hold one step for a gesture, then seal it. */
  hold: () => void;
  seal: () => void;
  /** The Pose "Editing" choice and Auto key (editor state, shared with the canvas). */
  editing: 'auto' | 'base';
  onEditing: (e: 'auto' | 'base') => void;
  autoKey: boolean;
  onAutoKey: (on: boolean) => void;
  /** Auto 3D: its options (kept per project in editor state), the run, and whether it is planning. */
  auto: AutoOptions;
  onAuto: (o: AutoOptions) => void;
  onRunAuto: () => void;
  autoBusy: boolean;
  shots: ShotOptions;
  onShots: (o: ShotOptions) => void;
  /** Hover previews on the canvas (a shot tile, an Easing menu item). */
  onShotHover: (recipe: ShotRecipe | null) => void;
  onEaseHover: (e: Easing | null) => void;
  /** A linked Start was unlinked by its first edit: toast with Undo for the whole gesture. */
  onUnlinked: (fromName: string) => void;
  openMenu: (spec: MenuSpec) => void;
  /** The device finish colour and a frame of the recording, for the shot tiles. */
  finish: string;
  screen?: string;
  /** Plain message toast (Copy as edits.json). */
  toast: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Icons (16 px grid, drawn like ui.tsx's)

const I = {
  chevL: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m10 4-4 4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  chevD: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  chevR: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  updown: <svg width="8" height="12" viewBox="0 0 8 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1 4.5 4 1.5l3 3M1 7.5l3 3 3-3" /></svg>,
  more: <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" /></svg>,
  spark: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8l5.1-1.4L8 1.5Z" fill="currentColor" /></svg>,
  trash: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4" /></svg>,
  reset: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v3h3" /></svg>,
  info: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="8" cy="8" r="6.2" /><path d="M8 7.2v4M8 4.9v.1" strokeLinecap="round" /></svg>,
  prev: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.5 4 5.5 8l4 4" /></svg>,
  next: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6.5 4 4 4-4 4" /></svg>,
  kf: <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2 13.8 8 8 13.8 2.2 8Z" fill="currentColor" strokeLinejoin="round" /></svg>,
  kfAdd: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true"><path d="M8 1.6 14.4 8 8 14.4 1.6 8Z" /><path d="M8 5.4v5.2M5.4 8h5.2" /></svg>,
  goKf: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><path d="M8 1.6 14.4 8 8 14.4 1.6 8Z" /><circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" /></svg>,
  autokey: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="8" cy="9" r="5.2" /><path d="M8 9V6.3M6.4 1.8h3.2M8 1.8v2" /></svg>,
  link: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M6.8 9.2a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.7.7M9.2 6.8a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.7-.7" /></svg>,
  // macOS caution: the system yellow triangle with a dark mark (reads on light and dark).
  warn: (
    <svg className="p3-caution" width="15" height="14" viewBox="0 0 15 14" aria-hidden="true">
      <path d="M6.2 1.2a1.5 1.5 0 0 1 2.6 0l5.6 9.8a1.5 1.5 0 0 1-1.3 2.2H1.9A1.5 1.5 0 0 1 .6 11l5.6-9.8Z" fill="var(--p3-yellow)" />
      <path d="M7.5 4.6v3.9" stroke="#1d1d1f" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="7.5" cy="10.6" r=".9" fill="#1d1d1f" />
    </svg>
  ),
};

/** A lit sphere per light preset, drawn from LIGHT_PRESETS (the rig the renderer uses). */
function LightSphere({ name, azimuth }: { name: LightPreset; azimuth: number }) {
  const P = LIGHT_PRESETS[name];
  const id = `p3-sph-${name}`;
  const base = Math.round(28 + P.ambient * 500);
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
      <defs>
        <radialGradient id={`${id}-b`} cx="15" cy="13" r="18" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={`rgb(${base + 20},${base + 20},${base + 24})`} />
          <stop offset="1" stopColor={`rgb(${base - 14},${base - 14},${base - 12})`} />
        </radialGradient>
        <clipPath id={`${id}-c`}>
          <circle cx="18" cy="18" r="13" />
        </clipPath>
        {P.boxes.map((b, i) => {
          const az = ((b.azimuth + azimuth) * Math.PI) / 180;
          const el = (b.elevation * Math.PI) / 180;
          const x = 18 + Math.sin(az) * Math.cos(el) * 11;
          const y = 18 - Math.sin(el) * 11;
          const r = 4 + b.w * b.h * 4.5;
          const vis = Math.cos(az) > -0.2 ? 1 : 0.55; // boxes behind the phone read as rims
          return (
            <radialGradient key={i} id={`${id}-${i}`} cx={x.toFixed(1)} cy={y.toFixed(1)} r={r.toFixed(1)} gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor={b.color} stopOpacity={Math.min(1, b.intensity * 0.95 * vis).toFixed(2)} />
              <stop offset="1" stopColor={b.color} stopOpacity="0" />
            </radialGradient>
          );
        })}
      </defs>
      <circle cx="18" cy="18" r="13" fill={`url(#${id}-b)`} />
      <g clipPath={`url(#${id}-c)`}>
        {P.boxes.map((_, i) => (
          <circle key={i} cx="18" cy="18" r="13" fill={`url(#${id}-${i})`} />
        ))}
      </g>
      <circle cx="18" cy="18" r="13" fill="none" stroke="rgba(0,0,0,.25)" strokeWidth=".5" />
    </svg>
  );
}

const POSE_FIELDS: { key: PoseKey; label: string; unit: string; scale: number; soft?: [number, number]; origin?: number }[] = [
  { key: 'turn', label: 'Turn', unit: '°', scale: 1, soft: [-360, 360] },
  { key: 'tilt', label: 'Tilt', unit: '°', scale: 1 },
  { key: 'rotate', label: 'Rotate', unit: '°', scale: 1 },
  { key: 'size', label: 'Size', unit: '%', scale: 100, origin: 100 },
  { key: 'x', label: 'Horizontal', unit: '%', scale: 100 },
  { key: 'y', label: 'Vertical', unit: '%', scale: 100 },
];

/** The six pose rows (Light and Focus live behind Animate lighting / focus in a move). */
function PoseRows({
  pose,
  mixed,
  onChange,
  onBegin,
  onCommit,
}: {
  pose: Pose;
  mixed?: ReadonlySet<PoseKey>;
  onChange: (key: PoseKey, value: number, info: { delta: number; typed: boolean }) => void;
  onBegin: () => void;
  onCommit: () => void;
}) {
  return (
    <div className="p3-tracks">
      {POSE_FIELDS.map((f) => (
        <Track
          key={f.key}
          label={f.label}
          unit={f.unit}
          value={Math.round(pose[f.key] * f.scale)}
          min={POSE_RANGE[f.key][0] * f.scale}
          max={POSE_RANGE[f.key][1] * f.scale}
          soft={f.soft}
          origin={f.origin}
          mixed={mixed?.has(f.key)}
          title={mixed?.has(f.key) ? 'These moves differ. Drag to change each by the same amount; type to set all.' : undefined}
          onBegin={onBegin}
          onCommit={onCommit}
          onChange={(v, info) => onChange(f.key, v / f.scale, { delta: info.delta / f.scale, typed: info.typed })}
        />
      ))}
    </div>
  );
}

/** A popover pinned beside an anchor element: below it (Auto 3D) or to the inspector's left (the curve). */
function usePinned(anchor: React.RefObject<HTMLElement | null>, open: boolean, place: 'below' | 'left-of-inspector') {
  const [pos, setPos] = useState<{ left: number; top: number; arrow: number } | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return setPos(null);
    const update = () => {
      const a = anchor.current?.getBoundingClientRect();
      const pop = popRef.current;
      if (!a || !pop) return;
      if (place === 'below') {
        // Under the chevron that opened it, its arrow on the chevron, kept 16 px inside the window.
        const w = pop.offsetWidth;
        const cx = a.left + a.width / 2;
        const left = Math.max(8, Math.min(window.innerWidth - w - 16, cx - w + 62));
        setPos({ left, top: a.bottom + 10, arrow: cx - left - 6 });
      } else {
        const insp = anchor.current?.closest('.inspector')?.getBoundingClientRect();
        const w = pop.offsetWidth;
        const h = pop.offsetHeight;
        const cy = a.top + a.height / 2;
        // Kept above the timeline, as the approved mockups place it.
        const floor = document.querySelector('.ed-timeline')?.getBoundingClientRect().top ?? window.innerHeight;
        const top = Math.max(60, Math.min(cy - 34, floor - h - 8));
        setPos({ left: (insp?.left ?? a.left) - w - 12, top, arrow: cy - top - 6 });
      }
    };
    update();
    const ro = new ResizeObserver(update);
    if (popRef.current) ro.observe(popRef.current);
    window.addEventListener('resize', update);
    const scroller = anchor.current?.closest('.inspector-body');
    scroller?.addEventListener('scroll', update, { passive: true });
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
      scroller?.removeEventListener('scroll', update);
    };
  }, [open, anchor, place]);
  return { popRef, pos };
}

/** Close a popover on a press outside it (and outside its anchor) or on Esc. */
function useDismiss(open: boolean, refs: React.RefObject<HTMLElement | null>[], close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useLayoutEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (refs.some((r) => r.current?.contains(t))) return;
      if ((t as Element).closest?.('.p3-menu-root')) return; // its own menus
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

// ---------------------------------------------------------------------------

export function Phone3DPanel(props: Phone3DPanelProps) {
  const { proj, apply3d, playhead, selected, hold, seal } = props;
  const p3: Phone3D | undefined = proj.phone3d;
  const moves = p3?.transitions ?? [];
  const sel = selected.filter((id) => moves.some((m) => m.id === id));
  if (p3 && sel.length === 1) return <MoveView {...props} p3={p3} id={sel[0]} />;
  if (p3 && sel.length > 1) return <MultiView {...props} p3={p3} ids={sel} />;
  return <HomeView {...props} p3={p3} begin={hold} end={seal} playhead={playhead} apply3d={apply3d} />;
}

// ---------------------------------------------------------------------------
// Home

function HomeView(props: Phone3DPanelProps & { p3: Phone3D | undefined; begin: () => void; end: () => void }) {
  const { proj, p3, apply3d, playhead, fps, warnings, begin, end } = props;
  const on = !!p3?.enabled;
  const gate = phone3dActive(proj);
  const inactive = on && !gate.active ? inactiveText(gate.reason) : null;
  const shown = p3 ?? defaultPhone3D();
  const chip = chipFor(shown, playhead, { editing: props.editing, autoKey: props.autoKey, fps });
  const listed = warnings.filter((w) => w.code !== 'inactive');
  const autoRef = useRef<HTMLDivElement>(null);
  const chevRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [autoOpen, setAutoOpen] = useState(false);
  const { popRef, pos } = usePinned(chevRef, autoOpen, 'below');
  useDismiss(autoOpen, [popRef, autoRef], () => setAutoOpen(false));

  const settings = (patch: Record<string, unknown>) => apply3d({ op: 'phone3d', ...patch });
  /** A one-off pose change (Reset to front). */
  const editPose = (patch: Partial<Pose>) => {
    const r = poseEditOps(shown, chip, patch, playhead);
    if ('error' in r) return props.toast(r.error);
    if (r.seek !== undefined) props.onSeek(r.seek);
    apply3d(r.ops);
  };
  // A field drag edits one keyframe from start to end (fixed when it begins).
  const lock = useRef<PoseLock | null>(null);
  const beginPose = () => {
    begin();
    const id = crypto.randomUUID();
    const r = lockPose(shown, chip, playhead, id);
    if ('error' in r) {
      lock.current = null;
      return props.toast(r.error);
    }
    if (r.seek !== undefined) props.onSeek(r.seek);
    if (r.ops.length && !apply3d(r.ops, { ids: [id] })) return (lock.current = null);
    lock.current = r.lock;
  };
  const changePose = (patch: Partial<Pose>) => {
    if (lock.current) apply3d(lockedOps(lock.current, patch));
  };

  const autoSplit = (
    <div className="p3-actions">
      <div className="split-btn" ref={autoRef}>
        <Button
          className={`split-main${props.autoBusy ? ' is-busy' : ''}`}
          aria-busy={props.autoBusy}
          title="Plan 3D shots around the taps: turns in the pauses, the phone faces front for every tap"
          onClick={() => !props.autoBusy && props.onRunAuto()}
        >
          {props.autoBusy ? (
            <>
              <span className="p3-spinner" aria-hidden="true" />
              Planning…
            </>
          ) : (
            <>
              {I.spark}
              Auto 3D
            </>
          )}
        </Button>
        <button ref={chevRef} type="button" className="btn btn-secondary btn-md split-toggle" aria-label="Auto 3D options" aria-expanded={autoOpen} onClick={() => setAutoOpen((o) => !o)}>
          {I.chevD}
        </button>
      </div>
      <button
        ref={moreRef}
        type="button"
        className="p3-more"
        aria-label="More 3D actions"
        title="Remove 3D, Clear moves, Copy as edits.json"
        onClick={() => {
          const r = moreRef.current!.getBoundingClientRect();
          props.openMenu({
            x: r.right - 220,
            y: r.bottom + 4,
            width: 220,
            items: [
              { id: 'remove', label: 'Remove 3D', disabled: !p3, run: () => apply3d({ op: 'phone3d', clear: true }, { announce: '3D removed' }) },
              { id: 'clear', label: 'Clear Moves', disabled: !p3?.transitions.length, run: () => apply3d({ op: 'clearTransitions' }, { announce: `${p3?.transitions.length ?? 0} moves cleared` }) },
              { type: 'separator' },
              {
                id: 'copy',
                label: 'Copy as edits.json',
                disabled: !p3,
                run: () => {
                  if (!p3) return;
                  void navigator.clipboard.writeText(JSON.stringify(phone3dAsOps(p3), null, 2) + '\n');
                  props.toast('3D setup copied as edits.json');
                },
              },
            ],
          });
        }}
      >
        {I.more}
      </button>
    </div>
  );

  let head: React.ReactNode = autoSplit;
  if (!on) {
    head = (
      <div className="p3-empty">
        {autoSplit}
        <p className="hint">Plans turns and hero angles around your taps. Or switch 3D on and pose the phone yourself.</p>
      </div>
    );
  } else if (inactive) {
    const fix = warnings.find((w) => w.code === 'inactive')?.fix;
    head = (
      <div className="p3-inactive" role="note">
        {I.info}
        <span>
          <b>{inactive.title}</b> {inactive.body}
        </span>
        {fix && (
          <Button size="sm" onClick={() => apply3d(fix)}>
            Turn on frame
          </Button>
        )}
      </div>
    );
  }

  const dim = !on || !!inactive;
  const resetFront = (
    <Button size="sm" className="p3-iconbtn" title="Reset to front (double-click the phone)" onClick={() => editPose({ turn: 0, tilt: 0, rotate: 0 })}>
      {I.reset}
      Reset to front
    </Button>
  );

  return (
    <div className="inspector-body">
      <Section
        title="3D phone"
        actions={
          <input
            type="checkbox"
            role="switch"
            className="switch"
            aria-label="3D phone"
            checked={on}
            onChange={(e) => apply3d({ op: 'phone3d', enabled: e.target.checked })}
          />
        }
      >
        {head}
      </Section>
      {autoOpen && (
        <div ref={popRef} className="p3-pop" role="dialog" aria-label="Auto 3D" style={pos ? ({ left: pos.left, top: pos.top, '--arrow-x': `${pos.arrow}px` } as React.CSSProperties) : { visibility: 'hidden' }}>
          <h4>Auto 3D</h4>
          <Segmented
            label="Style"
            value={props.auto.style}
            options={[
              { value: 'subtle', label: 'Subtle' },
              { value: 'hero', label: 'Hero' },
              { value: 'bold', label: 'Bold' },
            ]}
            onChange={(style) => props.onAuto({ ...props.auto, style })}
          />
          <p className="hint">
            {
              {
                subtle: 'A soft settle and a slow float. The phone faces front for every tap.',
                hero: 'Hero angles in the pauses and a spin-in intro. The phone faces front for every tap.',
                bold: 'Bigger turns, a turn to the back in long pauses. The phone faces front for every tap.',
              }[props.auto.style]
            }
          </p>
          <Switch label="Keep existing moves" hint="Off replaces the moves you have" checked={props.auto.keep} onChange={(keep) => props.onAuto({ ...props.auto, keep })} />
          <Switch label="Use scene changes" hint="Hide cuts behind a turn" checked={props.auto.scenes} onChange={(scenes) => props.onAuto({ ...props.auto, scenes })} />
          <Button
            variant="primary"
            disabled={props.autoBusy}
            onClick={() => {
              setAutoOpen(false);
              props.onRunAuto();
            }}
          >
            {I.spark}&nbsp;Run Auto 3D
          </Button>
        </div>
      )}
      {on && !inactive && listed.length > 0 && (
        <Section title="Warnings">
          <div className="p3-warns">
            {listed.map((w, i) => (
              <div
                key={`${w.code}-${w.transitionId ?? ''}-${i}`}
                className="p3-warn"
                role="button"
                tabIndex={0}
                title="Show this moment"
                onClick={() => w.at !== undefined && props.onSeek(w.at)}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && w.at !== undefined) {
                    e.preventDefault();
                    props.onSeek(w.at);
                  }
                }}
              >
                {I.warn}
                <time>{w.at !== undefined ? clock(w.at) : ''}</time>
                <span>{warningText(w, props.kindAt)}</span>
                <span className="p3-warn-end">
                  {w.fix ? (
                    <Button
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        apply3d(w.fix!);
                      }}
                    >
                      Fix
                    </Button>
                  ) : (
                    <span className="p3-warn-go">{I.chevR}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}
      <div className={dim ? 'p3-dimmed' : undefined} aria-disabled={dim || undefined}>
        <Section title="Pose" actions={resetFront}>
          <ChipRow {...props} p3={shown} chip={chip} disabled={dim} />
          <PoseRows
            pose={chip.pose}
            onBegin={beginPose}
            onCommit={() => {
              lock.current = null;
              end();
            }}
            onChange={(k, v) => changePose({ [k]: v })}
          />
        </Section>
        <Section title="Shots">
          <ShotGallery
            options={props.shots}
            onOptions={props.onShots}
            finish={props.finish}
            screen={props.screen}
            onHover={props.onShotHover}
            onInsert={(recipe, mirrored) => {
              const op: EditOp =
                recipe === 'float'
                  ? { op: 'shot', recipe }
                  : {
                      op: 'shot',
                      recipe,
                      at: playhead,
                      intensity: props.shots.strength,
                      direction: mirrored ? -1 : 1,
                      return: props.shots.ret,
                      ...(props.shots.length !== null ? { duration: props.shots.length } : {}),
                    };
              props.onShotHover(null);
              apply3d(op, { announce: `${RECIPE_LABEL[recipe]}${mirrored ? ' (mirrored)' : ''} added` });
            }}
          />
        </Section>
      </div>
      {on && !inactive && p3 && <LookSections p3={p3} settings={settings} begin={begin} end={end} />}
    </div>
  );
}

/** The "Editing" chip and the keyframe buttons: Auto key | previous | this key / go / add | next. */
function ChipRow(props: Phone3DPanelProps & { p3: Phone3D; chip: Chip; disabled: boolean }) {
  const { p3, chip, playhead, apply3d } = props;
  const moves = p3.transitions;
  const chipRef = useRef<HTMLButtonElement>(null);
  const text =
    chip.mode === 'on' ? (
      <>
        <span className="kfd on" />
        <span className="p3-target-text">On {chip.label}</span>
      </>
    ) : chip.mode === 'near' ? (
      <>
        <span className="kfd hollow" />
        <span className="p3-target-text">
          Near {chip.label} <span className="muted">· {chip.dist!.toFixed(2)} s</span>
        </span>
      </>
    ) : chip.mode === 'holding' ? (
      <>
        <span className="kfd hollow" />
        <span className="p3-target-text">Holding {chip.label}</span>
      </>
    ) : chip.mode === 'none' ? (
      <span className="p3-target-text">
        No key <span className="muted">· a change adds a move</span>
      </span>
    ) : (
      <span className="p3-target-text">
        Base pose <span className="muted">· {moves.length ? 'the resting pose' : 'whole video'}</span>
      </span>
    );
  const prev = prevKey(moves, playhead);
  const next = nextKey(moves, playhead);
  const addHere = () => {
    const t = playhead;
    apply3d({ op: 'addTransition', start: Math.max(0, t), end: t + 1.2, to: { turn: Math.min(POSE_RANGE.turn[1], chip.pose.turn + 25) } });
  };
  const mid =
    chip.mode === 'on' ? (
      <button type="button" className="on" title={`On ${chip.label}. Click to open this move.`} onClick={() => chip.target.kind !== 'base' && props.onSelect([chip.target.id], chip.target.kind === 'from' ? 'start' : 'end')}>
        {I.kf}
      </button>
    ) : chip.mode === 'near' ? (
      <button type="button" className="go" title={`Go to ${chip.label} (${chip.dist!.toFixed(2)} s)`} onClick={() => chip.keyTime !== undefined && props.onSeek(chip.keyTime)}>
        {I.goKf}
      </button>
    ) : (
      <button type="button" className="add" title="Add a move here (T)" onClick={addHere}>
        {I.kfAdd}
      </button>
    );
  return (
    <div className="p3-editing">
      <button
        ref={chipRef}
        type="button"
        className="p3-target"
        title="What a pose change edits. Click to choose Base pose."
        onClick={() => {
          const r = chipRef.current!.getBoundingClientRect();
          const autoLabel =
            chip.mode === 'base' && props.editing === 'base'
              ? moves.length
                ? 'The keyframe at the playhead'
                : 'Base pose · whole video'
              : chip.mode === 'none'
                ? 'No key · a change adds a move'
                : chip.mode === 'base'
                  ? 'Base pose · whole video'
                  : `${chip.mode === 'on' ? 'On' : chip.mode === 'near' ? 'Near' : 'Holding'} ${chip.label}`;
          props.openMenu({
            x: r.left,
            y: r.bottom + 4,
            width: 250,
            items: [
              { id: 'head', label: 'At the playhead', head: true },
              { id: 'auto', label: autoLabel, checked: props.editing === 'auto', run: () => props.onEditing('auto') },
              { type: 'separator' },
              { id: 'base', label: moves.length ? 'Base pose · the resting pose' : 'Base pose · whole video', checked: props.editing === 'base', run: () => props.onEditing('base') },
              { type: 'separator' },
              { id: 'autokey', label: 'Auto key', checked: props.autoKey, run: () => props.onAutoKey(!props.autoKey) },
            ],
          });
        }}
      >
        {text}
        {I.updown}
      </button>
      <span className="kf-nav">
        <button
          type="button"
          className={`p3-autokey${props.autoKey ? ' on' : ''}`}
          aria-pressed={props.autoKey}
          title={`Auto key ${props.autoKey ? 'on' : 'off'}. On: between moves, a pose change adds a move at the playhead. Off: it edits the pose you see held.`}
          onClick={() => props.onAutoKey(!props.autoKey)}
        >
          {I.autokey}
        </button>
        <span className="kf-sep" />
        <button type="button" title="Previous keyframe (J)" disabled={prev === null} onClick={() => prev !== null && props.onSeek(prev)}>
          {I.prev}
        </button>
        {mid}
        <button type="button" title="Next keyframe (K)" disabled={next === null} onClick={() => next !== null && props.onSeek(next)}>
          {I.next}
        </button>
      </span>
    </div>
  );
}

function LookSections({ p3, settings, begin, end }: { p3: Phone3D; settings: (patch: Record<string, unknown>) => boolean; begin: () => void; end: () => void }) {
  const seg28 = <T extends string | number>(label: string, value: T, options: { value: T; label: string }[], onChange: (v: T) => void) => (
    <div className="p3-seg28-wrap">
      <Segmented label={label} value={value} options={options} onChange={onChange} />
    </div>
  );
  const g = { onBegin: begin, onCommit: end };
  return (
    <>
      <Section title="Look">
        <div className="p3-tracks">
          <Track label="Lens" unit="mm" value={Math.round(lensMm(p3.camera.fov))} min={LENS_RANGE[0]} max={LENS_RANGE[1]} title="Focal length. Longer is flatter." {...g} onChange={(v) => settings({ camera: { fov: Math.min(60, Math.max(8, fovForMm(v))) } })} />
          <Track label="Camera height" unit="°" value={p3.camera.elevation} min={0} max={30} title="Look at the phone from slightly above" {...g} onChange={(v) => settings({ camera: { elevation: v } })} />
          <Track label="Glass" unit="%" value={Math.round(p3.glass * 100)} min={0} max={100} title="The sheen on the front glass" {...g} onChange={(v) => settings({ glass: v / 100 })} />
        </div>
        <FormRow label="Back">
          {seg28('Back', p3.back, [
            { value: 'auto', label: 'Auto' },
            { value: 'glossy', label: 'Glossy' },
            { value: 'frosted', label: 'Frosted' },
          ], (back) => settings({ back }))}
        </FormRow>
      </Section>
      <Section title="Lighting">
        <div className="light-tiles" role="radiogroup" aria-label="Lighting preset">
          {LIGHT_PRESET_NAMES.map((n) => (
            <button key={n} type="button" role="radio" aria-checked={n === p3.light.preset} className={`light-tile${n === p3.light.preset ? ' on' : ''}`} onClick={() => settings({ light: { preset: n } })}>
              <LightSphere name={n} azimuth={p3.light.azimuth} />
              {n[0].toUpperCase() + n.slice(1)}
            </button>
          ))}
        </div>
        <div className="p3-tracks">
          <Track label="Angle" unit="°" value={p3.light.azimuth} min={-180} max={180} title="Resting light angle. A move can turn it (Animate lighting)." {...g} onChange={(v) => settings({ light: { azimuth: v } })} />
          <Track label="Intensity" unit="%" value={Math.round(p3.light.intensity * 100)} min={0} max={200} origin={100} {...g} onChange={(v) => settings({ light: { intensity: v / 100 } })} />
        </div>
      </Section>
      <Section title="Shadow & focus">
        <Switch label="Shadow" checked={p3.shadow.on} onChange={(on) => settings({ shadow: { on } })} />
        <FormRow label="Falls on">
          {seg28('Falls on', p3.shadow.kind, [
            { value: 'wall', label: 'Wall' },
            { value: 'floor', label: 'Floor' },
          ], (kind) => settings({ shadow: { kind } }))}
        </FormRow>
        <div className="p3-tracks">
          <Track label="Opacity" unit="%" value={Math.round(p3.shadow.opacity * 100)} min={0} max={100} disabled={!p3.shadow.on} {...g} onChange={(v) => settings({ shadow: { opacity: v / 100 } })} />
          <Track label="Softness" unit="%" value={Math.round(p3.shadow.softness * 100)} min={0} max={100} disabled={!p3.shadow.on} {...g} onChange={(v) => settings({ shadow: { softness: v / 100 } })} />
        </div>
        <div className="p3-sep" />
        <Switch label="Depth of field" hint="A move can pull focus (Animate focus)" checked={p3.dof.on} onChange={(on) => settings({ dof: { on } })} />
        <div className="p3-tracks">
          <Track label="Amount" unit="%" value={Math.round(p3.dof.amount * 100)} min={0} max={100} disabled={!p3.dof.on} {...g} onChange={(v) => settings({ dof: { amount: v / 100 } })} />
          <Track label="Background blur" unit="%" value={Math.round(p3.dof.background * 100)} min={0} max={100} disabled={!p3.dof.on} {...g} onChange={(v) => settings({ dof: { background: v / 100 } })} />
        </div>
      </Section>
      <Section title="Float">
        <Switch label="Float" hint="A slow drift in height, turn and tilt" checked={p3.float.on} onChange={(on) => settings({ float: { on } })} />
        <div className="p3-tracks">
          <Track label="Amount" unit="%" value={Math.round(p3.float.amount * 100)} min={0} max={100} disabled={!p3.float.on} {...g} onChange={(v) => settings({ float: { amount: v / 100 } })} />
          <Track label="Period" unit="s" value={p3.float.period} min={2} max={20} step={0.5} digits={1} disabled={!p3.float.on} {...g} onChange={(v) => settings({ float: { period: v } })} />
        </div>
      </Section>
      <Section title="Export quality">
        <Switch label="Motion blur" checked={p3.motionBlur.on} onChange={(on) => settings({ motionBlur: { on } })} />
        <div className="p3-tracks">
          <Track label="Shutter" unit="°" value={Math.round(p3.motionBlur.shutter * 360)} min={0} max={360} step={5} disabled={!p3.motionBlur.on} title="How long each frame is exposed. 180° is film's half a frame." {...g} onChange={(v) => settings({ motionBlur: { shutter: v / 360 } })} />
          <Track label="Samples" value={p3.motionBlur.samples} min={2} max={32} disabled={!p3.motionBlur.on} title="The least per frame; fast moves take more" {...g} onChange={(v) => settings({ motionBlur: { samples: Math.round(v) } })} />
        </div>
        <FormRow label="Quality" hint={qualityHint(p3)}>
          {seg28('Quality', p3.supersample, [
            { value: 1, label: '1×' },
            { value: 2, label: '2×' },
            { value: 3, label: '3×' },
          ], (supersample) => settings({ supersample }))}
        </FormRow>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// One move

/** The Easing pop-up's menu: a picture per curve, over the button with the current item on it. */
function easingMenu(button: HTMLElement, current: EasingName | null, pick: (k: EasingName) => void, hover: (e: Easing | null) => void): MenuSpec {
  const r = button.getBoundingClientRect();
  const items: MenuItem[] = EASE_MENU.map((k) => ({
    id: k,
    label: EASE_LABEL[k],
    checked: k === current,
    picture: <CurveThumb e={EASE_PRESET[k]} />,
    run: () => pick(k),
  }));
  return { x: r.right - 200 + 6, y: r.top + r.height / 2, width: 200, big: true, items, overItem: current ?? undefined, onHover: (id) => hover(id ? EASE_PRESET[id as EasingName] : null) };
}

function KeyframeHalf({ which, on, time, hollow, mixed, onPick, onType }: { which: 'Start' | 'End'; on: boolean; time: number; hollow: boolean; mixed?: boolean; onPick: () => void; onType?: (t: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <button
      type="button"
      className={on ? 'on' : ''}
      title={mixed ? `Select ${which}` : `Select and go to ${clock(time)}. Double-click the time to type it.`}
      onClick={onPick}
      onDoubleClick={() => onType && !mixed && setDraft(clock(time))}
    >
      <span className="kf-top">
        <span className={`kfd${hollow ? ' hollow' : ''}`} />
        {which}
      </span>
      {draft !== null ? (
        <input
          className="kf-input"
          autoFocus
          aria-label={`${which} time`}
          value={draft}
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              const t = parseTime(draft, time);
              setDraft(null);
              if (t !== null) onType?.(t);
            } else if (e.key === 'Escape') setDraft(null);
          }}
          onBlur={() => setDraft(null)}
        />
      ) : (
        <span className="kf-time tnum">{mixed ? '–' : clock(time)}</span>
      )}
    </button>
  );
}

function MoveView(props: Phone3DPanelProps & { p3: Phone3D; id: string }) {
  const { p3, id, apply3d, playhead, fps, hold, seal } = props;
  const moves = p3.transitions;
  const i = moves.findIndex((m) => m.id === id);
  const m = moves[i];
  const starts = resolveStarts(p3);
  const start = starts[i];
  const isStart = props.activeKey === 'start';
  const pose = isStart ? start : m.to;
  const linked = !m.from;
  const dur = m.end - m.start;
  const prevName = i > 0 ? moveName(moves, moves[i - 1].id) : 'the base pose';
  const fitted = isFitted(m);
  const [squeezeEdit, setSqueezeEdit] = useState(false);
  const [tpop, setTpop] = useState(false);
  const [lightShown, setLightShown] = useState(false);
  const [focusShown, setFocusShown] = useState(false);
  const [hoverEase, setHoverEase] = useState<Easing | null>(null);
  const onEaseHover = (e: Easing | null) => {
    setHoverEase(e);
    props.onEaseHover(e);
  };
  const rowRef = useRef<HTMLDivElement>(null);
  const curveBtn = useRef<HTMLButtonElement>(null);
  const popupBtn = useRef<HTMLButtonElement>(null);
  const altDown = useRef(false);
  const { popRef, pos } = usePinned(rowRef, tpop, 'left-of-inspector');
  useDismiss(tpop, [popRef, curveBtn, popupBtn], () => setTpop(false));
  const keyTime = isStart ? m.start : m.end;
  const end = isStart ? 'from' : 'to';
  const half = 0.5 / Math.max(1, fps);
  const lightAnimated = m.to.light !== start.light;
  const focusAnimated = m.to.focus !== start.focus;
  const az = p3.light.azimuth;

  /** A change in this view: what you see is what you edit, so the playhead goes to the keyframe first. */
  const begin = () => {
    hold();
    if (Math.abs(playhead - keyTime) > half) props.onSeek(keyTime);
  };
  const setPose = (patch: Partial<Pose>) => {
    const unlinking = isStart && linked;
    if (apply3d({ op: 'setPose', id, end, ...patch }) && unlinking) props.onUnlinked(prevName);
  };
  const easing = (e: Easing, fit: boolean) => apply3d({ op: 'editTransition', id, easing: e, ...(fit && e.kind === 'spring' ? { fitDuration: true } : {}) });
  const pickEasing = (k: EasingName) => {
    if (k === 'spring') return easing(m.easing.kind === 'spring' ? m.easing : EASE_PRESET.spring, true);
    if (k === 'bezier') {
      const [x1, y1, x2, y2] = bezierFrom(m.easing);
      return easing({ kind: 'bezier', x1, y1, x2, y2 }, false);
    }
    easing({ kind: k } as Easing, false);
  };

  const durField =
    fitted && !squeezeEdit ? (
      <DerivedTrack label="Settles" text={dur.toFixed(2)} unit="s" title="Set by the spring (Pace and Bounce). Double-click to type a shorter time and squeeze it." onDoubleClick={() => setSqueezeEdit(true)} />
    ) : (
      <div onPointerDownCapture={(e) => (altDown.current = e.altKey)}>
        <Track
          label="Duration"
          unit="s"
          plain
          value={+dur.toFixed(2)}
          min={0.1}
          max={60}
          step={0.01}
          title="Start stays put. Hold Option to keep End instead. Double-click to type."
          onBegin={hold}
          onCommit={() => {
            seal();
            setSqueezeEdit(false);
          }}
          onChange={(v) => apply3d(durationOps(moves, [id], v, altDown.current))}
        />
      </div>
    );

  return (
    <>
      <div className="mv-bar">
        <button type="button" className="mv-back" title="All moves" aria-label="All moves" onClick={() => props.onSelect([])}>
          {I.chevL}
        </button>
        <span className="mv-title">
          <b>{moveName(moves, id)}</b>
          <span>{shotLine(moves, id)}</span>
        </span>
        <button type="button" className="mv-trash" title="Remove move (⌫)" aria-label="Remove move" onClick={() => apply3d({ op: 'removeTransition', id }) && props.onSelect([])}>
          {I.trash}
        </button>
      </div>
      <div className="inspector-body p3-movebody">
        <section className="section p3-sticky" aria-label="Keyframe">
          <header className="section-head">
            <h3>Keyframe</h3>
            <div className="section-actions">
              <button type="button" className="p3-textbtn" title="Swap the Start and End poses" onClick={() => apply3d({ op: 'editTransition', id, swap: true })}>
                Swap Start / End
              </button>
            </div>
          </header>
          <div className="section-body">
            <div className="kf-toggle">
              <KeyframeHalf
                which="Start"
                on={isStart}
                time={m.start}
                hollow={linked}
                onPick={() => {
                  props.onSelect([id], 'start');
                  props.onSeek(m.start);
                }}
                onType={(t) => apply3d({ op: 'editTransition', id, start: Math.max(0, t) })}
              />
              <KeyframeHalf
                which="End"
                on={!isStart}
                time={m.end}
                hollow={false}
                onPick={() => {
                  props.onSelect([id], 'end');
                  props.onSeek(m.end);
                }}
                onType={(t) => apply3d({ op: 'editTransition', id, end: t })}
              />
            </div>
            <div className="mt-row" ref={rowRef}>
              {durField}
              <button
                ref={popupBtn}
                type="button"
                className="p3-popup"
                title="Easing"
                onClick={() => props.openMenu(easingMenu(popupBtn.current!, m.easing.kind, pickEasing, onEaseHover))}
              >
                <CurveGlyph e={m.easing} dur={dur} />
                <span className="p3-popup-name">{EASE_LABEL[m.easing.kind]}</span>
                {I.updown}
              </button>
              <button ref={curveBtn} type="button" className={`mt-curve${tpop ? ' on' : ''}`} title="Edit the curve" aria-expanded={tpop} onClick={() => setTpop((o) => !o)}>
                <CurveGlyph e={m.easing} w={34} h={18} dur={dur} />
              </button>
            </div>
          </div>
        </section>
        <Section title="Pose">
          {isStart && (
            <label className="row switch-row p3-linkrow">
              <span className="row-text">
                <span className="row-label">
                  {I.link}Linked to the end of {prevName}
                </span>
                <span className="row-hint">{linked ? 'Drag any value to unlink.' : 'This Start has its own pose.'}</span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                checked={linked}
                onChange={(e) => apply3d({ op: 'editTransition', id, from: e.target.checked ? null : { ...start } })}
              />
            </label>
          )}
          <PoseRows pose={pose} onBegin={begin} onCommit={seal} onChange={(k, v) => setPose({ [k]: v })} />
          {!isStart && (
            <div className="p3-under">
              <button type="button" className="p3-textbtn p3-iconbtn" title="Make the End the same pose as the Start" onClick={() => apply3d({ op: 'editTransition', id, resetEnd: true })}>
                {I.reset}
                Reset End to Start
              </button>
            </div>
          )}
          <div className="p3-anim">
            <Switch
              label="Animate lighting"
              checked={lightAnimated || lightShown}
              onChange={(v) => {
                setLightShown(v);
                if (!v && lightAnimated) apply3d({ op: 'setPose', id, end: 'to', light: start.light });
              }}
            />
            {(lightAnimated || lightShown) && (
              <div className="p3-tracks">
                <Track
                  label="Angle"
                  unit="°"
                  value={Math.round(az + pose.light)}
                  min={Math.max(-180, az - 180)}
                  max={Math.min(180, az + 180)}
                  soft={[-180, 180]}
                  origin={az}
                  title={`Light angle at this keyframe. The tick is the resting angle (Look › Lighting, ${minus(az)}°).`}
                  onBegin={begin}
                  onCommit={seal}
                  onChange={(v) => setPose({ light: Math.max(-180, Math.min(180, v - az)) })}
                />
              </div>
            )}
            <Switch
              label="Animate focus"
              hint={p3.dof.on ? undefined : 'Depth of field is off'}
              checked={focusAnimated || focusShown}
              onChange={(v) => {
                setFocusShown(v);
                if (!v && focusAnimated) apply3d({ op: 'setPose', id, end: 'to', focus: start.focus });
              }}
            />
            {(focusAnimated || focusShown) && (
              <div className="p3-tracks">
                <Track
                  label="Focus"
                  unit="%"
                  value={Math.round(pose.focus * 100)}
                  min={0}
                  max={200}
                  origin={100}
                  disabled={!p3.dof.on}
                  title="100% is the Depth of field amount. 0% is sharp."
                  onBegin={begin}
                  onCommit={seal}
                  onChange={(v) => setPose({ focus: v / 100 })}
                />
              </div>
            )}
          </div>
        </Section>
      </div>
      {tpop && (
        <div
          ref={popRef}
          className="p3-pop tpop"
          role="dialog"
          aria-label="Easing curve"
          style={pos ? ({ left: pos.left, top: pos.top, '--arrow-y': `${pos.arrow}px` } as React.CSSProperties) : { visibility: 'hidden' }}
        >
          <TimingPopover move={m} playhead={playhead} hover={hoverEase} onEasing={easing} onBegin={hold} onCommit={seal} />
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Many moves

function MultiView(props: Phone3DPanelProps & { p3: Phone3D; ids: string[] }) {
  const { p3, ids, apply3d, hold, seal } = props;
  const moves = p3.transitions;
  const list = moves.filter((m) => ids.includes(m.id));
  const n = list.length;
  const isStart = props.activeKey === 'start';
  const which = isStart ? 'from' : 'to';
  const poses = keyPoses(p3, ids, which);
  const mixed = mixedChannels(poses);
  const kinds = new Set(list.map((m) => m.easing.kind));
  const mixedEase = kinds.size > 1;
  const durs = list.map((m) => m.end - m.start);
  const mixedDur = !durs.every((d) => Math.abs(d - durs[0]) < 0.005);
  const popupBtn = useRef<HTMLButtonElement>(null);
  const base = useRef<ReturnType<typeof keyPoses> | null>(null);
  const durBase = useRef<DurationBase | null>(null);
  const names = [...new Set(list.map((m) => moveName(moves, m.id)))];
  const all = samePart(moves, list[0].id);
  const sub =
    names.length === 1 && all.length === n && all.every((x) => ids.includes(x))
      ? `All “${names[0]}” moves`
      : names.length <= 2
        ? names.join(' and ')
        : `${names.length} kinds of move`;
  const starts = resolveStarts(p3);
  const lightAnimated = list.every((m) => m.to.light !== starts[moves.indexOf(m)].light);
  const az = p3.light.azimuth;
  const pick = (k: EasingName) => {
    const e = k === 'bezier' ? (() => {
      const [x1, y1, x2, y2] = bezierFrom(list[0].easing);
      return { kind: 'bezier' as const, x1, y1, x2, y2 };
    })() : EASE_PRESET[k];
    apply3d(easingOps(ids, e, k === 'spring'));
  };

  return (
    <>
      <div className="mv-bar">
        <button type="button" className="mv-back" title="All moves" aria-label="All moves" onClick={() => props.onSelect([])}>
          {I.chevL}
        </button>
        <span className="mv-title">
          <b>{n} moves</b>
          <span>{sub}</span>
        </span>
        <button
          type="button"
          className="mv-trash"
          title={`Remove ${n} moves (⌫)`}
          aria-label={`Remove ${n} moves`}
          onClick={() => apply3d(ids.map((x) => ({ op: 'removeTransition', id: x }))) && props.onSelect([])}
        >
          {I.trash}
        </button>
      </div>
      <div className="inspector-body p3-movebody">
        <section className="section p3-sticky" aria-label="Keyframe">
          <header className="section-head">
            <h3>Keyframe</h3>
            <div className="section-actions">
              <button type="button" className="p3-textbtn" title="Swap the Start and End poses of each move" onClick={() => apply3d(ids.map((x) => ({ op: 'editTransition', id: x, swap: true })))}>
                Swap Start / End
              </button>
            </div>
          </header>
          <div className="section-body">
            <div className="kf-toggle">
              <KeyframeHalf which="Start" on={isStart} time={0} hollow={false} mixed onPick={() => props.onSelect(ids, 'start')} />
              <KeyframeHalf which="End" on={!isStart} time={0} hollow={false} mixed onPick={() => props.onSelect(ids, 'end')} />
            </div>
            <p className="hint kf-help">Changes apply to all {n} moves.</p>
            <div className="mt-row">
              <Track
                label="Duration"
                unit="s"
                plain
                value={+durs[0].toFixed(2)}
                min={0.1}
                max={60}
                step={0.01}
                mixed={mixedDur}
                title="Typing sets every move's duration; Start stays put."
                onBegin={() => {
                  hold();
                  durBase.current = durationBase(moves, ids);
                }}
                onCommit={() => {
                  seal();
                  durBase.current = null;
                }}
                onChange={(v, info) =>
                  apply3d(mixedDur && !info.typed ? durationDragOps(durBase.current ?? durationBase(moves, ids), info.delta) : durationOps(moves, ids, v))
                }
              />
              <button
                ref={popupBtn}
                type="button"
                className="p3-popup"
                title="Easing for every selected move"
                onClick={() => props.openMenu(easingMenu(popupBtn.current!, mixedEase ? null : list[0].easing.kind, pick, props.onEaseHover))}
              >
                {!mixedEase && <CurveGlyph e={list[0].easing} />}
                <span className="p3-popup-name">{mixedEase ? 'Mixed' : EASE_LABEL[list[0].easing.kind]}</span>
                {I.updown}
              </button>
              <button type="button" className="mt-curve" title={mixedEase ? 'The curves differ' : 'Open one move to edit its curve'} disabled>
                {mixedEase ? (
                  <svg width="34" height="18" viewBox="0 0 34 18" aria-hidden="true">
                    <path d="M3 15 L31 3" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 3" strokeLinecap="round" />
                  </svg>
                ) : (
                  <CurveGlyph e={list[0].easing} w={34} h={18} dur={durs[0]} />
                )}
              </button>
            </div>
          </div>
        </section>
        <Section title="Pose">
          <PoseRows
            pose={poses[0]}
            mixed={mixed}
            onBegin={() => {
              hold();
              base.current = keyPoses(p3, ids, which);
            }}
            onCommit={() => {
              seal();
              base.current = null;
            }}
            onChange={(k, v, info) => {
              const typed = info.typed || !mixed.has(k);
              apply3d(multiPoseOps(p3, ids, which, k, typed ? v : info.delta, typed ? 'set' : 'add', base.current ?? undefined));
            }}
          />
          {!isStart && (
            <div className="p3-under">
              <button type="button" className="p3-textbtn p3-iconbtn" onClick={() => apply3d(ids.map((x) => ({ op: 'editTransition', id: x, resetEnd: true })))}>
                {I.reset}
                Reset End to Start
              </button>
            </div>
          )}
          <div className="p3-anim">
            <Switch
              label="Animate lighting"
              checked={lightAnimated}
              onChange={(v) => {
                if (!v) apply3d(list.map((m) => ({ op: 'setPose', id: m.id, end: 'to', light: starts[moves.indexOf(m)].light })));
              }}
            />
            {lightAnimated && (
              <div className="p3-tracks">
                <Track
                  label="Angle"
                  unit="°"
                  value={Math.round(az + poses[0].light)}
                  min={Math.max(-180, az - 180)}
                  max={Math.min(180, az + 180)}
                  soft={[-180, 180]}
                  origin={az}
                  mixed={mixed.has('light')}
                  onBegin={() => {
                    hold();
                    base.current = keyPoses(p3, ids, which);
                  }}
                  onCommit={seal}
                  onChange={(v, info) => {
                    const typed = info.typed || !mixed.has('light');
                    apply3d(multiPoseOps(p3, ids, which, 'light', typed ? v - az : info.delta, typed ? 'set' : 'add', base.current ?? undefined));
                  }}
                />
              </div>
            )}
          </div>
        </Section>
      </div>
    </>
  );
}

/** FRONT for the Reset 3D Pose pair (§4.1). */
export const RESET_3D_POSE: EditOp[] = [{ op: 'clearTransitions' }, { op: 'setPose', target: 'base', ...FRONT }];
