// The taps track: one marker per touch suggestion, on the output timeline.
// Drag a marker to retime it, click to select it (then click the preview to
// place it), right-click or Delete to remove it, Option-click the lane to add
// a tap at the playhead. Faint hatching marks still stretches ("waits").
import React, { useRef } from 'react';
import type { TapSuggestion } from '../../../shared/taps';

const KIND_LABEL: Record<TapSuggestion['kind'], string> = {
  tap: 'Tap',
  swipe: 'Swipe',
  longpress: 'Long press',
  typing: 'Typing',
};

export function TapsLane({
  taps,
  waits,
  outDur,
  selectedId,
  onSelect,
  onMove,
  onRemove,
  onAdd,
}: {
  /** Output-time taps. */
  taps: TapSuggestion[];
  /** Output-time still stretches; `pending` ones still play at 1x. */
  waits: { start: number; end: number; pending: boolean }[];
  outDur: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Live while dragging: the marker's new output time. */
  onMove: (id: string, outT: number) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}) {
  const laneRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; pointer: number; x: number; t: number; moved: boolean } | null>(null);
  const pct = (t: number) => `${(Math.max(0, t) / outDur) * 100}%`;

  const onDown = (e: React.PointerEvent, s: TapSuggestion) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // not an active pointer (synthetic events): the drag still tracks moves over the marker
    }
    drag.current = { id: s.id, pointer: e.pointerId, x: e.clientX, t: s.t, moved: false };
  };
  const onMovePointer = (e: React.PointerEvent) => {
    const d = drag.current;
    const lane = laneRef.current;
    if (!d || d.pointer !== e.pointerId || !lane) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const w = lane.getBoundingClientRect().width || 1;
    onMove(d.id, Math.min(outDur, Math.max(0, d.t + (dx / w) * outDur)));
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) onSelect(d.id);
  };

  return (
    <div
      ref={laneRef}
      className="lane lane-taps"
      onClick={(e) => {
        if (!e.altKey) return; // a plain click seeks, like every lane
        e.stopPropagation();
        onAdd();
      }}
    >
      {waits.map((w, i) => (
        <div
          key={`w${i}`}
          className={`waitmark${w.pending ? '' : ' done'}`}
          style={{ left: pct(w.start), width: pct(w.end - w.start) }}
        />
      ))}
      {taps.map((s) => {
        const span = s.kind !== 'tap' && s.duration ? s.duration : 0;
        return (
          <div
            key={s.id}
            className={`tapmark kind-${s.kind}${span ? ' span' : ''}${s.id === selectedId ? ' selected' : ''}`}
            title={`${KIND_LABEL[s.kind]} at ${s.t.toFixed(2)}s, ${Math.round(s.confidence * 100)}% sure. Drag to move, right-click to remove.`}
            style={{
              left: pct(s.t),
              width: span ? pct(span) : undefined,
              opacity: 0.35 + 0.65 * Math.min(1, Math.max(0, s.confidence)),
            }}
            onPointerDown={(e) => onDown(e, s)}
            onPointerMove={onMovePointer}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRemove(s.id);
            }}
          >
            {s.kind === 'typing' && <span>Typing</span>}
          </div>
        );
      })}
      {taps.length === 0 && waits.length === 0 && (
        <span className="lane-note">Option-click to add a tap at the playhead</span>
      )}
    </div>
  );
}
