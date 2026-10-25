// The 3D lane: one block per move (phone3d.transitions), under Zoom and above
// Taps. Built like the audio lane: pointer capture, a press that does not
// move selects, a press that moves drags.
//
// - Keys are 12 px diamonds with 20 px hit areas, drawn above the playhead.
//   A linked Start is hollow. Touching keys are two halves, each pointing
//   into its own move. Under 28 px a block hides its keys.
// - Edge (or key) drag retimes that end; body drag slides the move. Both send
//   ABSOLUTE {start, end}, worked out from the move as it was at pointerdown
//   plus the total pointer offset (§5.3), and snap to frames, the playhead
//   and taps within 6 px (⇧: no snap). One undo step per drag.
// - Drag on an empty part draws a selection box; Shift-click adds or removes
//   a move; Option-click adds a move there.
// - Double-click a block frames it; double-click a key goes to it.

import React, { useMemo, useRef, useState } from 'react';
import type { PoseTransition } from '../../../shared/phone3d/model';
import { BlockCurve } from './EasingCurve';
import { clock, dragTimes, laneHit, laneLayout, marqueeIds, moveName, snapTime, type LaneHit, type LaneKey } from './panelModel';

export interface TransitionLaneProps {
  moves: readonly PoseTransition[];
  /** Output duration (s) and the lane's width (px): together the scale. */
  outDur: number;
  laneW: number;
  /** The part of the lane in view, lane px (only what is near it is drawn). */
  view: [number, number];
  selected: readonly string[];
  /** The keyframe the inspector edits on the one selected move. */
  activeKey: 'start' | 'end' | null;
  /** Moves a warning points at: yellow hatching. */
  warnIds: ReadonlySet<string>;
  playhead: number;
  /** Output-time taps, for snapping. */
  tapTimes: readonly number[];
  fps: number;
  /** 3D is drawn flat here (App Store): the lane dims. */
  dimmed?: boolean;
  onSelect: (ids: string[], key?: 'start' | 'end') => void;
  onBegin: () => void;
  onRetime: (id: string, times: { start: number; end: number }) => void;
  onEnd: () => void;
  onAdd: (t: number) => void;
  onMenu: (id: string, x: number, y: number) => void;
  onFrame: (ids: string[]) => void;
  onSeek: (t: number) => void;
}

interface Drag {
  pointer: number;
  x0: number;
  id: string;
  part: 'start' | 'end' | 'body';
  orig: { start: number; end: number };
  moved: boolean;
  shift: boolean;
}

interface Marquee {
  pointer: number;
  x0: number;
  x1: number;
  base: string[];
}

function KeyMark({ k, sel, active }: { k: LaneKey; sel: boolean; active: boolean }) {
  const c = sel ? 'var(--accent)' : 'var(--p3-key)';
  const d = k.shape === 'left' ? 'M0 -6.5 L-6.5 0 L0 6.5Z' : k.shape === 'right' ? 'M0 -6.5 L6.5 0 L0 6.5Z' : 'M0 -6.5 L6.5 0 L0 6.5 L-6.5 0Z';
  const ring = k.shape === 'left' ? 'M0 -9.5 L-9.5 0 L0 9.5' : k.shape === 'right' ? 'M0 -9.5 L9.5 0 L0 9.5' : 'M0 -9.5 L9.5 0 L0 9.5 L-9.5 0Z';
  return (
    <svg className={`kdia${active ? ' active' : ''}`} style={{ left: k.x }} width="48" height="24" viewBox="-24 -12 48 24" aria-hidden="true">
      <rect x={k.hit[0] - k.x} y="-10" width={k.hit[1] - k.hit[0]} height="20" fill="transparent" />
      {active && <path d={ring} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" />}
      {k.hollow ? (
        <>
          <path d={d} fill="var(--surface)" />
          <path d={d} fill="none" stroke={c} strokeWidth="1.5" strokeLinejoin="round" />
        </>
      ) : (
        <path d={d} fill={c} stroke="var(--surface)" strokeWidth="1" strokeLinejoin="round" />
      )}
    </svg>
  );
}

export function TransitionLane(props: TransitionLaneProps) {
  const { moves, outDur, laneW, view, selected, activeKey, warnIds, playhead, tapTimes, fps, dimmed } = props;
  const pps = laneW > 0 && outDur > 0 ? laneW / outDur : 1;
  const layout = useMemo(() => laneLayout(moves, { pxPerSec: pps, x0: view[0], x1: view[1], selected }), [moves, pps, view, selected]);
  const byId = useMemo(() => new Map(moves.map((m) => [m.id, m])), [moves]);
  const laneRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [dragView, setDragView] = useState<{ id: string; part: Drag['part']; t: number; what: string } | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const swallowClick = useRef(false);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const xOf = (e: { clientX: number }) => e.clientX - (laneRef.current?.getBoundingClientRect().left ?? 0);
  const cursorFor = (h: LaneHit) => (h.kind === 'key' || h.kind === 'edge' ? 'ew-resize' : h.kind === 'body' ? 'grab' : undefined);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const x = xOf(e);
    const hit = laneHit(layout, x);
    if (hit.kind === 'empty') {
      if (e.altKey) {
        e.stopPropagation();
        swallowClick.current = true;
        props.onAdd(Math.min(outDur, Math.max(0, x / pps)));
        return;
      }
      if (!moves.length) return; // a plain click seeks, as on every lane
      laneRef.current?.setPointerCapture(e.pointerId);
      setMarquee({ pointer: e.pointerId, x0: x, x1: x, base: e.shiftKey ? [...selected] : [] });
      return;
    }
    e.stopPropagation();
    swallowClick.current = true;
    const id = hit.kind === 'key' ? hit.key.moveId : hit.id;
    const part = hit.kind === 'key' ? hit.key.which : hit.part;
    const m = byId.get(id);
    if (!m) return;
    if (e.shiftKey) {
      props.onSelect(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
      return;
    }
    laneRef.current?.setPointerCapture(e.pointerId);
    drag.current = { pointer: e.pointerId, x0: e.clientX, id, part, orig: { start: m.start, end: m.end }, moved: false, shift: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (marquee && marquee.pointer === e.pointerId) {
      setMarquee({ ...marquee, x1: xOf(e) });
      return;
    }
    if (!d) {
      const c = cursorFor(laneHit(layout, xOf(e)));
      if (c !== cursor) setCursor(c);
      return;
    }
    if (d.pointer !== e.pointerId) return;
    const dx = e.clientX - d.x0;
    if (!d.moved) {
      if (Math.abs(dx) < 3) return;
      d.moved = true;
      props.onBegin();
      if (!selected.includes(d.id) || selected.length !== 1) props.onSelect([d.id], d.part === 'body' ? undefined : d.part);
    }
    let next = dragTimes(d.orig, d.part, dx / pps, outDur);
    let what = '';
    if (!e.shiftKey) {
      const cands = [{ t: playhead, what: 'on playhead' }, ...tapTimes.map((t) => ({ t, what: 'on a tap' }))];
      if (d.part === 'body') {
        const a = snapTime(next.start, cands, pps, fps);
        const b = snapTime(next.end, cands, pps, fps);
        // Whichever end is nearer a playhead or tap snaps; with neither, the Start lands on a frame.
        const da = a.what === 'frame' ? Infinity : Math.abs(a.t - next.start);
        const db = b.what === 'frame' ? Infinity : Math.abs(b.t - next.end);
        const useEnd = db < da;
        what = useEnd ? b.what : da === Infinity ? '' : a.what;
        next = dragTimes(d.orig, 'body', dx / pps + (useEnd ? b.t - next.end : a.t - next.start), outDur);
      } else {
        const edge = d.part === 'start' ? next.start : next.end;
        const s = snapTime(edge, cands, pps, fps);
        what = s.what === 'frame' ? '' : s.what;
        next = dragTimes(d.orig, d.part, dx / pps + (s.t - edge), outDur);
      }
    }
    props.onRetime(d.id, next);
    setDragView({ id: d.id, part: d.part, t: d.part === 'end' ? next.end : next.start, what });
  };

  const finish = (e: React.PointerEvent<HTMLDivElement>) => {
    if (marquee && marquee.pointer === e.pointerId) {
      const moved = Math.abs(marquee.x1 - marquee.x0) > 3;
      setMarquee(null);
      if (moved) {
        swallowClick.current = true;
        const ids = marqueeIds(moves, marquee.x0, marquee.x1, pps);
        props.onSelect([...new Set([...marquee.base, ...ids])]);
      }
      return;
    }
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    setDragView(null);
    if (d.moved) props.onEnd();
    else props.onSelect([d.id], d.part === 'body' ? undefined : d.part);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const hit = laneHit(layout, xOf(e));
    if (hit.kind === 'key') {
      e.stopPropagation();
      const m = byId.get(hit.key.moveId);
      if (m) props.onSeek(hit.key.which === 'start' ? m.start : m.end);
    } else if (hit.kind === 'body' || hit.kind === 'edge') {
      e.stopPropagation();
      props.onFrame([hit.id]);
    }
  };

  const onContextMenu = (e: React.MouseEvent) => {
    const hit = laneHit(layout, xOf(e));
    if (hit.kind === 'empty') return; // the timeline's own menu
    e.preventDefault();
    e.stopPropagation();
    const id = hit.kind === 'key' ? hit.key.moveId : hit.id;
    props.onMenu(id, e.clientX, e.clientY);
  };

  const single = selected.length === 1;
  const dragged = dragView ? byId.get(dragView.id) : undefined;
  return (
    <div
      ref={laneRef}
      className={`lane lane-3d${dimmed ? ' is-dimmed' : ''}`}
      style={{ cursor: drag.current ? (drag.current.part === 'body' ? 'grabbing' : 'ew-resize') : cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onPointerLeave={() => !drag.current && setCursor(undefined)}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onClick={(e) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        e.stopPropagation();
      }}
    >
      {!moves.length && <span className="lane-note">Option-click or press T to add a move</span>}
      {layout.ticks.map((t) => (
        <div key={t.id} className={`dense-mark${selected.includes(t.id) ? ' sel' : ''}`} style={{ left: t.x }} />
      ))}
      {layout.blocks.map((b) => {
        const m = byId.get(b.id)!;
        const sel = selected.includes(b.id);
        return (
          <React.Fragment key={b.id}>
            {b.link && <div className="shot-link" style={{ left: b.link[0], width: b.link[1] - b.link[0] }} />}
            <div
              className={`moveblock${sel ? ' sel' : ''}${warnIds.has(b.id) ? ' warn' : ''}${dragView?.id === b.id ? ' dragging' : ''}`}
              style={{ left: b.x, width: b.w }}
              title={`${moveName(moves, b.id)} · ${m.easing.kind === 'bezier' ? 'Custom' : m.easing.kind} · ${(m.end - m.start).toFixed(2)} s`}
            >
              <BlockCurve e={m.easing} dur={m.end - m.start} w={b.w} />
              {b.label && <span className="mlabel">{b.label}</span>}
            </div>
            {b.tail > 0 && <div className="squeeze-tail" style={{ left: b.x + b.w, width: b.tail }} title="Cut off: the spring needs longer than this move" />}
          </React.Fragment>
        );
      })}
      {layout.keys.map((k) => (
        <KeyMark key={`${k.moveId}-${k.which}`} k={k} sel={selected.includes(k.moveId)} active={single && selected[0] === k.moveId && activeKey === k.which} />
      ))}
      {marquee && Math.abs(marquee.x1 - marquee.x0) > 3 && (
        <div className="p3-marquee" style={{ left: Math.min(marquee.x0, marquee.x1), width: Math.abs(marquee.x1 - marquee.x0) }} />
      )}
      {dragView && dragged && (
        <>
          {dragView.what && <div className="p3-snap" style={{ left: dragView.t * pps }} />}
          <div className="p3-tip" style={{ left: dragView.t * pps }}>
            <span>
              {dragView.part === 'body'
                ? `${clock(dragged.start)}–${clock(dragged.end)}`
                : `${dragView.part === 'end' ? 'End' : 'Start'} ${clock(dragView.t)} · ${(dragged.end - dragged.start).toFixed(2)} s`}
              {dragView.what ? ` · ${dragView.what}` : ''}
            </span>
            <span className="mods">
              {dragView.part === 'body' ? (
                <>
                  Edge retimes · <b>body slides</b> · ⇧ no snap
                </>
              ) : (
                <>
                  <b>Edge retimes</b> · body slides · ⇧ no snap
                </>
              )}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
