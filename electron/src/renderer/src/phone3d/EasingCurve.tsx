// The easing curve: small pictures (the Easing pop-up, its menu, the lane
// blocks) and the big graph in the curve popover beside the inspector. Every
// curve samples the shared ease() (shared/phone3d/easing3d), the function the
// renderer moves the phone with, so the picture is the motion.
//
// The big graph:
// - the playhead is a thin accent line with a small dot (static: no loop)
// - a handle is a larger neutral ring (Custom: two bezier handles; Spring:
//   one ring at the peak, sideways = pace, up/down = bounce)
// - a squeezed spring (D8) draws what plays (solid), the real spring (dashed
//   ghost) and the part the move cuts off (hatched), with Fit to spring
// - Custom has 30% room above 1 and below 0, so anticipation and overshoot fit

import React, { useRef, useState } from 'react';
import { ease, springSettleTime, springX } from '../../../shared/phone3d/easing3d';
import { BEZIER_RANGE, type Easing } from '../../../shared/phone3d/model';
import { Button } from '../ui';
import {
  bezierText,
  easeCaption,
  easeSamples,
  isFitted,
  PACE_RANGE,
  parseBezier,
  springBounce,
  springFrom,
  springPace,
  springShortfall,
} from './panelModel';
import { Track } from './Track';

/** A tiny curve for the Easing pop-up button and the timing row. */
export function CurveGlyph({ e, w = 26, h = 15, dur = 0.8 }: { e: Easing; w?: number; h?: number; dur?: number }) {
  const n = 24;
  const pad = 2;
  const lo = e.kind === 'spring' || (e.kind === 'bezier' && (e.y1 < 0 || e.y2 > 1)) ? -0.1 : 0;
  const hi = e.kind === 'spring' || (e.kind === 'bezier' && e.y2 > 1) ? 1.25 : 1;
  const d = Array.from({ length: n + 1 }, (_, j) => {
    const v = ease(e, j / n, dur);
    return `${j ? 'L' : 'M'}${(pad + (j / n) * (w - 2 * pad)).toFixed(1)},${(h - pad - ((v - lo) / (hi - lo)) * (h - 2 * pad)).toFixed(1)}`;
  }).join('');
  return (
    <svg className="cglyph" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A menu picture: one shared frame and scale for every item, with the 0 and 1 lines drawn. */
export function CurveThumb({ e, w = 52, h = 30 }: { e: Easing; w?: number; h?: number }) {
  const lo = -0.12;
  const hi = 1.16;
  const pad = 3;
  const n = 32;
  const X = (u: number) => pad + u * (w - 2 * pad);
  const Y = (v: number) => h - pad - ((v - lo) / (hi - lo)) * (h - 2 * pad);
  const d = Array.from({ length: n + 1 }, (_, j) => `${j ? 'L' : 'M'}${X(j / n).toFixed(1)},${Y(ease(e, j / n, 0.8)).toFixed(1)}`).join('');
  return (
    <svg className="cthumb" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <rect x=".5" y=".5" width={w - 1} height={h - 1} rx="4" className="fr" />
      <line x1={pad} x2={w - pad} y1={Y(0)} y2={Y(0)} className="gl" />
      <line x1={pad} x2={w - pad} y1={Y(1)} y2={Y(1)} className="gl" />
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A faint picture of a move's ease inside its lane block, so timing reads on the lane. */
export function BlockCurve({ e, dur, w }: { e: Easing; dur: number; w: number }) {
  if (w < 26) return null;
  const n = Math.max(8, Math.min(48, Math.round(w / 6)));
  const pts = Array.from({ length: n + 1 }, (_, j) => {
    const v = ease(e, j / n, dur);
    return `${((j / n) * 100).toFixed(2)},${(100 - Math.max(-25, Math.min(125, v * 100))).toFixed(2)}`;
  }).join(' ');
  return (
    <svg className="bcurve" viewBox="0 -25 100 150" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const CV = { W: 308, H: 150, pl: 12, pr: 12, pt: 16, pb: 16 };

interface GraphProps {
  samples: number[];
  ymin: number;
  ymax: number;
  /** Share of the width the solid curve spans (a squeezed spring ends early). */
  span?: number;
  /** Where the move cuts a squeezed spring off (0..1 of the width). */
  cut?: number;
  ghost?: number[];
  band?: boolean;
  headroom?: boolean;
  dotU?: number | null;
  bez?: [number, number, number, number];
  peak?: [number, number];
  labelTR?: string;
  labelCut?: string;
  onHandle?: (which: '1' | '2' | 'spring', u: number, v: number, shift: boolean, phase: 'start' | 'move' | 'end') => void;
}

function Graph(o: GraphProps) {
  const { W, H, pl, pr, pt, pb } = CV;
  const iw = W - pl - pr;
  const ih = H - pt - pb;
  const span = o.span ?? 1;
  const X = (u: number) => pl + u * iw;
  const Y = (v: number) => pt + (1 - (v - o.ymin) / (o.ymax - o.ymin)) * ih;
  const path = (pts: number[], k = 1) => pts.map((v, i) => `${i ? 'L' : 'M'}${X((i / (pts.length - 1)) * k).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  const svgRef = useRef<SVGSVGElement>(null);
  const toUV = (ev: { clientX: number; clientY: number }): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    const k = W / r.width;
    const x = (ev.clientX - r.left) * k;
    const y = (ev.clientY - r.top) * k;
    return [(x - pl) / iw / span, o.ymin + (1 - (y - pt) / ih) * (o.ymax - o.ymin)];
  };
  const grab = (which: '1' | '2' | 'spring') => (e: React.PointerEvent) => {
    if (e.button !== 0 || !o.onHandle) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const [u, v] = toUV(e);
    o.onHandle(which, u, v, e.shiftKey, 'start');
    const el = e.currentTarget as Element;
    const move = (ev: PointerEvent) => {
      const [mu, mv] = toUV(ev);
      o.onHandle?.(which, mu, mv, ev.shiftKey, 'move');
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move as EventListener);
      el.removeEventListener('pointerup', up as EventListener);
      el.removeEventListener('pointercancel', up as EventListener);
      const [mu, mv] = toUV(ev);
      o.onHandle?.(which, mu, mv, ev.shiftKey, 'end');
    };
    el.addEventListener('pointermove', move as EventListener);
    el.addEventListener('pointerup', up as EventListener);
    el.addEventListener('pointercancel', up as EventListener);
  };
  const n = o.samples.length - 1;
  const top = Math.min(o.ymax, 1.3);
  return (
    <div className="curve">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Easing curve">
        {o.band && <rect className="band" x={pl} y={Y(top)} width={iw} height={Y(1) - Y(top)} />}
        {o.headroom && (
          <>
            <rect className="room" x={pl} y={Y(o.ymax)} width={iw} height={Y(1) - Y(o.ymax)} />
            <rect className="room" x={pl} y={Y(0)} width={iw} height={Y(o.ymin) - Y(0)} />
          </>
        )}
        <line className="base" x1={pl} x2={W - pr} y1={Y(1)} y2={Y(1)} />
        <line className="base" x1={pl} x2={W - pr} y1={Y(0)} y2={Y(0)} />
        {o.cut !== undefined && (
          <>
            <defs>
              <pattern id="p3-cuthatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="6" className="hatch" />
              </pattern>
            </defs>
            <rect x={X(o.cut)} y={pt - 6} width={X(1) - X(o.cut)} height={ih + 12} fill="url(#p3-cuthatch)" />
            <line className="cut" x1={X(o.cut)} x2={X(o.cut)} y1={pt - 8} y2={H - pb + 8} />
          </>
        )}
        {o.labelTR && (
          <text className="lbl" x={W - pr} y="11" textAnchor="end">
            {o.labelTR}
          </text>
        )}
        {o.labelCut && o.cut !== undefined && (
          <text className="lbl" x={X(o.cut) - 5} y={H - 3} textAnchor="end">
            {o.labelCut}
          </text>
        )}
        {o.ghost && <path className="ghost" d={path(o.ghost)} />}
        <path className="path" d={path(o.samples, span)} />
        {o.dotU != null && (() => {
          const i = Math.round(o.dotU * n);
          const x = X((i / n) * span);
          return (
            <>
              <line className="ph-line" x1={x} x2={x} y1={pt - 8} y2={H - pb + 8} />
              <circle className="ph-dot" cx={x} cy={Y(o.samples[i])} r="3.5" />
            </>
          );
        })()}
        {o.bez && (
          <>
            <line className="handle-line" x1={X(0)} y1={Y(0)} x2={X(o.bez[0])} y2={Y(o.bez[1])} />
            <line className="handle-line" x1={X(1)} y1={Y(1)} x2={X(o.bez[2])} y2={Y(o.bez[3])} />
            <circle className="anchor" cx={X(0)} cy={Y(0)} r="2.5" />
            <circle className="anchor" cx={X(1)} cy={Y(1)} r="2.5" />
            <circle className="handle" cx={X(o.bez[0])} cy={Y(o.bez[1])} r="6.5" onPointerDown={grab('1')}>
              <title>Handle 1. Shift-drag keeps it level.</title>
            </circle>
            <circle className="handle" cx={X(o.bez[2])} cy={Y(o.bez[3])} r="6.5" onPointerDown={grab('2')}>
              <title>Handle 2. Shift-drag keeps it level.</title>
            </circle>
          </>
        )}
        {o.peak && (
          <circle className="handle" cx={X(o.peak[0] * span)} cy={Y(o.peak[1])} r="6.5" onPointerDown={grab('spring')}>
            <title>Drag sideways for Pace, up or down for Bounce</title>
          </circle>
        )}
      </svg>
    </div>
  );
}

export interface TimingPopoverProps {
  move: { start: number; end: number; easing: Easing };
  playhead: number;
  /** An easing hovered in the Easing menu: drawn as a dashed ghost. */
  hover: Easing | null;
  /** A new easing for the move (`fit`: the length becomes the spring's settle time). */
  onEasing: (e: Easing, fit: boolean) => void;
  onBegin: () => void;
  onCommit: () => void;
}

/** The curve popover's content: the graph and its caption in one box, then Spring's or Custom's parameters. */
export function TimingPopover({ move, playhead, hover, onEasing, onBegin, onCommit }: TimingPopoverProps) {
  const e = move.easing;
  const dur = move.end - move.start;
  const inMove = playhead >= move.start - 0.01 && playhead <= move.end + 0.01;
  const dotU = inMove ? Math.min(1, Math.max(0, (playhead - move.start) / dur)) : null;
  const fitted = isFitted(move);
  const [advanced, setAdvanced] = useState(false);
  const [bezDraft, setBezDraft] = useState<string | null>(null);
  const start = useRef<Easing>(e);

  let graph: React.ReactNode;
  let caption = easeCaption(e);
  let action: React.ReactNode = null;
  let params: React.ReactNode = null;

  if (e.kind === 'spring') {
    const T = springSettleTime(e.stiffness, e.damping);
    const short = springShortfall(move);
    const sm = easeSamples(e, dur);
    let pk = 0;
    sm.forEach((v, j) => {
      if (v > sm[pk]) pk = j;
    });
    const L0 = Math.max(dur, T);
    const onHandle: GraphProps['onHandle'] = (_w, u, v, _shift, phase) => {
      if (phase === 'start') {
        start.current = e;
        onBegin();
      }
      // x: when the peak comes in the move → stiffness; y: overshoot → damping ratio.
      const tp = Math.max(0.03, Math.min(0.95, u)) * L0;
      const os = Math.min(0.6, Math.max(0.002, v - 1));
      const lz = -Math.log(os);
      const z = lz / Math.sqrt(Math.PI * Math.PI + lz * lz);
      const w = Math.PI / tp / Math.sqrt(1 - z * z);
      const k = Math.round(Math.min(1000, Math.max(1, w * w)));
      const c = +Math.min(200, Math.max(0.1, 2 * z * Math.sqrt(k))).toFixed(1);
      if (phase !== 'end') onEasing({ kind: 'spring', stiffness: k, damping: c }, fitted);
      else onCommit();
    };
    if (short) {
      const ghost = Array.from({ length: 65 }, (_, j) => springX(e.stiffness, e.damping, (j / 64) * T));
      graph = (
        <Graph
          samples={sm}
          span={dur / T}
          cut={dur / T}
          ghost={ghost}
          band
          ymin={-0.05}
          ymax={1.25}
          peak={[pk / 64, sm[pk]]}
          dotU={dotU}
          labelCut={`move ends · ${dur.toFixed(2)} s`}
          labelTR={`spring · ${T.toFixed(2)} s`}
          onHandle={onHandle}
        />
      );
      caption = `Squeezed: this spring needs ${T.toFixed(2)} s, so it plays ${Math.round((T / dur - 1) * 100)}% fast. The hatched part is cut.`;
      action = (
        <Button size="sm" onClick={() => onEasing(e, true)}>
          Fit to spring
        </Button>
      );
    } else {
      graph = <Graph samples={sm} band ymin={-0.05} ymax={1.25} peak={[pk / 64, sm[pk]]} dotU={dotU} onHandle={onHandle} ghost={hover ? easeSamples(hover, dur) : undefined} />;
    }
    const pace = springPace(e.stiffness);
    const bounce = springBounce(e.stiffness, e.damping);
    params = (
      <>
        <div className="p3-tracks">
          <Track
            label="Pace"
            value={+pace.toFixed(2)}
            unit="s"
            min={PACE_RANGE[0]}
            max={PACE_RANGE[1]}
            step={0.01}
            title="How quick the spring is (Apple's spring duration). Or drag the ring sideways."
            onBegin={onBegin}
            onCommit={onCommit}
            onChange={(v) => onEasing({ kind: 'spring', ...springFrom(v, bounce) }, fitted)}
          />
          <Track
            label="Bounce"
            value={Math.round(Math.max(0, bounce) * 100)}
            unit="%"
            min={0}
            max={100}
            title="0% has no overshoot. Or drag the ring up or down."
            onBegin={onBegin}
            onCommit={onCommit}
            onChange={(v) => onEasing({ kind: 'spring', ...springFrom(pace, v / 100) }, fitted)}
          />
        </div>
        <button type="button" className="p3-disclosure" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)}>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="m6 3.5 4.5 4.5L6 12.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Stiffness and damping
        </button>
        {advanced && (
          <div className="p3-tracks">
            <Track label="Stiffness" value={e.stiffness} min={1} max={1000} onBegin={onBegin} onCommit={onCommit} onChange={(v) => onEasing({ ...e, stiffness: v }, fitted)} />
            <Track label="Damping" value={e.damping} min={0.1} max={200} step={0.1} onBegin={onBegin} onCommit={onCommit} onChange={(v) => onEasing({ ...e, damping: v }, fitted)} />
          </div>
        )}
      </>
    );
  } else if (e.kind === 'bezier') {
    const onHandle: GraphProps['onHandle'] = (which, u, v, shift, phase) => {
      if (phase === 'start') {
        start.current = e;
        onBegin();
      }
      if (phase === 'end') return onCommit();
      const s = start.current.kind === 'bezier' ? start.current : e;
      const x = +Math.min(BEZIER_RANGE.x[1], Math.max(BEZIER_RANGE.x[0], u)).toFixed(2);
      const yLevel = which === '1' ? s.y1 : s.y2;
      const y = shift ? yLevel : +Math.min(1.3, Math.max(-0.3, v)).toFixed(2);
      onEasing(which === '1' ? { ...e, x1: x, y1: y } : { ...e, x2: x, y2: y }, false);
    };
    graph = <Graph samples={easeSamples(e, dur)} bez={[e.x1, e.y1, e.x2, e.y2]} ymin={-0.3} ymax={1.3} headroom dotU={dotU} onHandle={onHandle} />;
    const text = bezDraft ?? bezierText(e);
    params = (
      <>
        <label className="bez-css" title="Paste a cubic-bezier() from CSS, After Effects or easings.net">
          <input
            className={bezDraft !== null && !parseBezier(bezDraft) ? 'bad' : ''}
            spellCheck={false}
            aria-label="cubic-bezier"
            value={text}
            onChange={(ev) => setBezDraft(ev.target.value)}
            onKeyDown={(ev) => {
              ev.stopPropagation();
              if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
              if (ev.key === 'Escape') setBezDraft(null);
            }}
            onBlur={() => {
              const q = bezDraft !== null ? parseBezier(bezDraft) : null;
              if (q) onEasing({ kind: 'bezier', x1: q[0], y1: q[1], x2: q[2], y2: q[3] }, false);
              setBezDraft(q || bezDraft === null ? null : bezDraft);
            }}
          />
        </label>
        <p className="hint bez-hint">Paste a curve, or drag a handle. Shift-drag keeps it level.</p>
      </>
    );
  } else {
    graph = <Graph samples={easeSamples(e, dur)} ymin={-0.05} ymax={hover ? 1.25 : 1.08} dotU={dotU} ghost={hover ? easeSamples(hover, dur) : undefined} band={!!hover} />;
  }

  return (
    <>
      <div className="tbox">
        {graph}
        <div className="tcap">
          <p className="hint">{caption}</p>
          {action}
        </div>
      </div>
      {params}
    </>
  );
}
