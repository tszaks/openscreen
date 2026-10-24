#!/usr/bin/env node
// The 3D phone review harness (SPEC §6.4). It drives the agent CLI (never the
// original bundle: every render works on APFS clones in the run folder) and
// writes one page a person and model judges review:
//
//   node scripts/review3d.mjs <bundle> [--out dir] [--style hero] [--refs dir] [--no-clips] [--draft] [--bench bench.json] [--seed n]
//       flat vs 3D side by side at the planned moves and taps; a contact strip and a 3 s clip per shot recipe; the
//       Auto 3D plan drawn over the taps and waits; warnings; timings; blinded A/B pairs against the reference
//       captures in --refs (kept in /tmp, never committed); the 1-5 rubric
//   node scripts/review3d.mjs pairs --a <file|dir> --b <file|dir> [--labels a,b] --out dir [--seed n]
//       a blinded page for any two sets of clips or stills (the judged equal test, docs/EQUAL_TEST.md)
//   node scripts/review3d.mjs tally <run dir> [--equal a,b]
//       reads key.json and votes/*.json and prints the result: the look gate (ours preferred or tied in ≥ 60%
//       of the votes, no rubric axis under 3, Tyler + 3 model judges), or with --equal the equal test's score rule
//
// Default --out: /tmp/openscreen-review/<bundle>-<stamp>. key.json (which side is which) is written next to
// index.html: move it out of the folder before judges see it (tally needs it back).
//
// Prints one JSON object on stdout; progress lines go to stderr. Exit 0 ok, 1 something failed, 2 bad usage.

import { execFile, spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const AXES = ['silhouette', 'metal', 'glass', 'screen sharpness at an angle', 'motion feel', 'spring', 'shadow', 'legibility at taps', 'depth-of-field taste', 'would ship'];
export const RECIPES = ['spin-in', 'turn-to-back', 'hero-layback', 'settle', 'float'];
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO = new Set(['.mp4', '.mov', '.m4v', '.webm']);
/** Rules of the look gate (SPEC §6.4). */
export const GATE = { preferOrTie: 0.6, axisMin: 3, judges: 4 };
/** The equal test's score rule (docs/EQUAL_TEST.md): the agent within this many points of the person. */
export const EQUAL_MARGIN = 0.5;

// ---------------------------------------------------------------------------
// Pure helpers (exported for test/review3d.test.ts)

/** A small seeded PRNG (mulberry32): the same seed gives the same blinding. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Blinded pairs: each [a, b] gets a side by a coin flip and the order is shuffled, both from `seed`.
 * Returns the page's pairs (no labels) and the key (which label is on each side).
 */
export function blindPairs(items, seed) {
  const rnd = prng(seed);
  const order = items.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const pairs = [];
  const key = {};
  order.forEach((idx, n) => {
    const it = items[idx];
    const id = `pair-${String(n + 1).padStart(2, '0')}`;
    const flip = rnd() < 0.5;
    const L = flip ? it.b : it.a;
    const R = flip ? it.a : it.b;
    pairs.push({ id, L: L.file, R: R.file, kind: it.kind ?? null });
    key[id] = { L: L.label, R: R.label, ...(it.note ? { note: it.note } : {}) };
  });
  return { pairs, key };
}

/** Output seconds of a source time through info's clips (null when that moment is cut). */
export function sourceToOutput(clips, t) {
  for (const c of clips) {
    if (t >= c.sourceStart - 1e-9 && t <= c.sourceEnd + 1e-9) return c.outputStart + (t - c.sourceStart) / (c.speed || 1);
  }
  return null;
}

/**
 * A source window of `len` seconds with no gesture in it, inside [lo, hi]. `taps` are times or `{t, duration}`
 * (a swipe or long press covers t..t+duration); each is padded by 0.5 s on both sides. A window may start right
 * at a padded gesture's end. Of the free windows, the one that sits most inside a wait wins, then the earliest.
 * Falls back to `lo` (free: false) when none is free.
 */
export function quietWindow(taps, waits, len, lo, hi) {
  const pad = 0.5;
  const eps = 1e-9;
  const spans = taps
    .map((x) => (typeof x === 'number' ? { t: x, duration: 0 } : { t: x.t, duration: Math.max(0, x.duration ?? 0) }))
    .map(({ t, duration }) => ({ a: t - pad, b: t + duration + pad }))
    .sort((x, y) => x.a - y.a);
  const cands = [lo, ...spans.map((g) => g.b), ...waits.map((w) => w.start)].filter((s) => s >= lo - eps && s + len <= hi + eps);
  const free = (s) => spans.every((g) => g.b <= s + eps || g.a >= s + len - eps);
  const inWait = (s) => waits.reduce((m, w) => m + Math.max(0, Math.min(w.end, s + len) - Math.max(w.start, s)), 0);
  const ok = [...new Set(cands)].filter(free).sort((a, b) => inWait(b) - inWait(a) || a - b);
  return { start: ok[0] ?? lo, free: ok.length > 0 };
}

/** Every tap of a bundle, from project.json (info lists at most 100), as {t, duration} in source seconds. */
export function bundleTaps(projectJson, infoItems = []) {
  const all = Array.isArray(projectJson?.taps) ? projectJson.taps : infoItems;
  return all.filter((x) => Number.isFinite(x?.t)).map((x) => ({ t: x.t, duration: Number.isFinite(x.duration) ? x.duration : 0 }));
}

/** Sides whose shapes (width / height) differ by at most this share are centre-cropped to one shape; more is padded. */
export const CROP_LIMIT = 0.12;
/** Width of every placed pair file. */
export const PAIR_WIDTH = 1080;

/**
 * The one canvas both sides of a blinded pair are re-encoded to, so neither the container, the size nor the
 * shape tells the sides apart. Shapes within CROP_LIMIT: both are centre-cropped to the narrower shape (no bars).
 * Further apart: both are fitted and padded to the narrower shape, and `leak` is true (the bars show which side
 * had the other shape: crop the reference to the shape of ours before judging).
 */
export function pairCanvas(a, b, width = PAIR_WIDTH) {
  const ra = a.w / a.h;
  const rb = b.w / b.h;
  const aspect = Math.min(ra, rb);
  const diff = Math.abs(ra - rb) / Math.max(ra, rb);
  const h = 2 * Math.round(width / aspect / 2);
  const mode = diff <= CROP_LIMIT ? 'crop' : 'pad';
  return { w: width, h, aspect, diff: Math.round(diff * 1000) / 1000, mode, leak: mode === 'pad' };
}

/** The ffmpeg filter that puts one side on the pair canvas. */
export function pairFilter(c) {
  const fit = c.mode === 'crop'
    ? `crop='min(iw,ih*${c.aspect.toFixed(6)})':'min(ih,iw/${c.aspect.toFixed(6)})',scale=${c.w}:${c.h}:flags=lanczos`
    : `scale=${c.w}:${c.h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${c.w}:${c.h}:(ow-iw)/2:(oh-ih)/2:color=0x101010`;
  return `${fit},setsar=1`;
}

/** The layout preset (all of them draw the 3D phone) whose canvas shape is nearest a reference's. */
export const SHAPE_PRESETS = [
  { id: 'social-9x16', aspect: 9 / 16 },
  { id: 'feed-4x5', aspect: 4 / 5 },
  { id: 'square', aspect: 1 },
  { id: 'landscape-16x9', aspect: 16 / 9 },
];
export function nearestShapePreset(size) {
  const r = size.w / size.h;
  return SHAPE_PRESETS.reduce((best, p) => (Math.abs(Math.log(p.aspect / r)) < Math.abs(Math.log(best.aspect / r)) ? p : best)).id;
}

/** Stills to compare flat vs 3D: each shot's start, middle and end, then taps, at most `max`, sorted, 0.05 s apart. */
export function compareTimes(shots, taps, D, max = 12) {
  const want = [...shots.flatMap((s) => [s.start, (s.start + s.end) / 2, s.end]), ...taps];
  const out = [];
  for (const t of want) {
    if (out.length >= max) break;
    if (t < 0 || t >= D) continue;
    if (out.every((x) => Math.abs(x - t) >= 0.05)) out.push(Math.round(t * 1000) / 1000);
  }
  return out.sort((a, b) => a - b);
}

/** Pairs a reference capture with one of our renders: a file named after a recipe gets that recipe, else round-robin. */
export function matchRefs(refFiles, recipes) {
  let k = 0;
  return refFiles.map((f) => {
    const name = basename(f).toLowerCase();
    const r = recipes.find((x) => name.startsWith(x)) ?? recipes[k++ % recipes.length];
    return { ref: f, recipe: r };
  });
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r2 = (x) => (x === null ? null : Math.round(x * 100) / 100);

/** Every valid 1-5 score in a vote side. */
const scoresOf = (side) => Object.entries(side ?? {}).filter(([a, v]) => AXES.includes(a) && Number.isInteger(v) && v >= 1 && v <= 5);

/**
 * The look gate: over every judge's vote on every pair, the share where ours is picked or tied, and our mean per
 * rubric axis. Pass = share ≥ 60%, every axis ≥ 3, and at least 4 judges (Tyler + 3 model judges).
 */
export function tallyLook(key, votes, ours = 'ours') {
  let n = 0;
  let good = 0;
  const axis = Object.fromEntries(AXES.map((a) => [a, []]));
  const missing = [];
  for (const v of votes) {
    for (const [id, k] of Object.entries(key.pairs)) {
      const p = v.pairs?.[id];
      if (!p || !['L', 'R', 'tie'].includes(p.pick)) {
        missing.push(`${v.judge}: ${id}`);
        continue;
      }
      n++;
      if (p.pick === 'tie' || k[p.pick] === ours) good++;
      const side = k.L === ours ? 'L' : k.R === ours ? 'R' : null;
      if (side) for (const [a, s] of scoresOf(p.scores?.[side])) axis[a].push(s);
    }
  }
  const axisMean = Object.fromEntries(AXES.map((a) => [a, r2(mean(axis[a]))]));
  const low = AXES.filter((a) => axisMean[a] !== null && axisMean[a] < GATE.axisMin);
  const unscored = AXES.filter((a) => axisMean[a] === null);
  const share = n ? good / n : null;
  const judges = votes.length;
  return {
    judges,
    votes: n,
    preferOrTie: r2(share),
    axisMean,
    lowAxes: low,
    unscoredAxes: unscored,
    missing,
    pass: share !== null && share >= GATE.preferOrTie && !low.length && !unscored.length && judges >= GATE.judges && !missing.length,
    rule: `ours preferred or tied in ≥ ${GATE.preferOrTie * 100}% of votes, every axis ≥ ${GATE.axisMin}, ≥ ${GATE.judges} judges, every pair voted`,
  };
}

/** The equal test's score rule: each label's mean over every axis, side and judge; pass when b ≥ a − 0.5. */
export function tallyEqual(key, votes, a, b) {
  const per = { [a]: [], [b]: [] };
  const missing = [];
  for (const v of votes) {
    for (const [id, k] of Object.entries(key.pairs)) {
      const p = v.pairs?.[id];
      if (!p) {
        missing.push(`${v.judge}: ${id}`);
        continue;
      }
      for (const side of ['L', 'R']) if (per[k[side]]) for (const [, s] of scoresOf(p.scores?.[side])) per[k[side]].push(s);
    }
  }
  const ma = mean(per[a]);
  const mb = mean(per[b]);
  return {
    judges: votes.length,
    mean: { [a]: r2(ma), [b]: r2(mb) },
    difference: ma === null || mb === null ? null : r2(mb - ma),
    missing,
    pass: ma !== null && mb !== null && mb >= ma - EQUAL_MARGIN - 1e-9 && !missing.length,
    rule: `${b} scores no more than ${EQUAL_MARGIN} below ${a} (warnings and editor-only actions are checked by hand, docs/EQUAL_TEST.md)`,
  };
}

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The plan timeline as SVG: waits, taps, moves (labelled), warnings, in output seconds. */
export function planSvg({ D, taps, waits, moves, warnings }, width = 1000) {
  const pad = 30;
  const x = (t) => pad + (Math.max(0, Math.min(D, t)) / (D || 1)) * (width - 2 * pad);
  const parts = [`<svg viewBox="0 0 ${width} 150" width="100%" role="img" aria-label="Auto 3D plan over the taps">`];
  parts.push(`<line x1="${pad}" y1="120" x2="${width - pad}" y2="120" class="axis"/>`);
  const step = D > 60 ? 10 : D > 20 ? 5 : 1;
  for (let t = 0; t <= D + 1e-9; t += step) parts.push(`<line x1="${x(t)}" y1="118" x2="${x(t)}" y2="124" class="axis"/><text x="${x(t)}" y="140" class="tick">${t}s</text>`);
  for (const w of waits) parts.push(`<rect x="${x(w.start)}" y="20" width="${Math.max(1, x(w.end) - x(w.start))}" height="90" class="wait"><title>wait ${w.start.toFixed(2)}–${w.end.toFixed(2)} s</title></rect>`);
  for (const m of moves) {
    parts.push(`<rect x="${x(m.start)}" y="44" width="${Math.max(2, x(m.end) - x(m.start))}" height="30" rx="4" class="move"><title>${esc(m.label)} ${m.start.toFixed(2)}–${m.end.toFixed(2)} s${m.reason ? ` — ${esc(m.reason)}` : ''}</title></rect>`);
    parts.push(`<text x="${x(m.start) + 3}" y="38" class="mlabel">${esc(m.label)}</text>`);
  }
  for (const t of taps) parts.push(`<line x1="${x(t)}" y1="82" x2="${x(t)}" y2="110" class="tap"><title>tap ${t.toFixed(2)} s</title></line>`);
  for (const w of warnings) if (typeof w.at === 'number') parts.push(`<circle cx="${x(w.at)}" cy="14" r="5" class="warn"><title>${esc(w.code)}: ${esc(w.message)}</title></circle>`);
  parts.push('</svg>');
  return parts.join('');
}

// ---------------------------------------------------------------------------
// The page

const THEME_HEAD = `<script>document.documentElement.dataset.theme=localStorage.theme||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');</script>`;
const CSS = `
:root{--bg:#fafafa;--card:#fff;--ink:#111;--mute:#777;--line:#e6e6e6;--green:#22a55b;--yellow:#e0a800;--red:#d93636;--shadow:0 1px 2px rgba(0,0,0,.05),0 4px 16px rgba(0,0,0,.06)}
:root[data-theme=dark]{--bg:#0d0d0d;--card:#171717;--ink:#f2f2f2;--mute:#8a8a8a;--line:#262626;--shadow:0 1px 2px rgba(0,0,0,.4),0 4px 16px rgba(0,0,0,.35)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 80px}header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:20px}
h1{font-size:26px;letter-spacing:-.02em;margin:0}h2{font-size:18px;margin:0 0 12px}.sub{color:var(--mute);font-size:13px}
.card{background:var(--card);border-radius:16px;box-shadow:var(--shadow);padding:18px;margin-bottom:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:6px}
img,video{width:100%;border-radius:10px;background:#000;display:block;object-fit:contain}.pair img,.pair video{max-height:560px}.recipe{display:grid;grid-template-columns:200px 1fr;gap:14px;align-items:start;margin-bottom:18px}.recipe video{max-height:360px}figure{margin:0}figcaption{font-size:12px;color:var(--mute);margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}.g{background:var(--green)}.y{background:var(--yellow)}.r{background:var(--red)}
svg .axis{stroke:var(--mute)}svg .tick{fill:var(--mute);font-size:11px;text-anchor:middle}svg .wait{fill:var(--line)}svg .move{fill:var(--ink);opacity:.8}
svg .mlabel{fill:var(--ink);font-size:11px}svg .tap{stroke:var(--mute);stroke-width:2}svg .warn{fill:var(--yellow)}
.rubric{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;margin-top:10px}.axisrow{display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:2px 0}
.axisrow select,.pick select{font:inherit;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:2px 6px}
textarea,input[type=text]{width:100%;font:inherit;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:6px}
button.act{font:inherit;padding:8px 14px;border-radius:10px;border:0;background:var(--ink);color:var(--bg);cursor:pointer}
.toggle{position:relative;display:grid;place-items:center;width:38px;height:38px;padding:0;border:0;border-radius:12px;background:var(--card);color:var(--ink);box-shadow:var(--shadow);cursor:pointer;transition:transform .12s cubic-bezier(.22,1,.36,1)}
.toggle:active{transform:scale(.96)}.toggle:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.iconWrap{position:relative;display:grid;place-items:center;width:20px;height:20px;transition:transform .26s cubic-bezier(.34,1.3,.64,1)}.toggle[aria-pressed=true] .iconWrap{transform:scale(1.08)}
.ico{position:absolute;inset:1px;display:grid;place-items:center;transition:opacity .16s cubic-bezier(.16,1,.3,1),filter .16s cubic-bezier(.16,1,.3,1),transform .26s cubic-bezier(.34,1.3,.64,1)}
.ico.sun{transform:rotate(0) scale(1)}.ico.moon{opacity:0;filter:blur(2px);transform:rotate(-30deg) scale(.7)}
[data-theme=dark] .ico.sun{opacity:0;filter:blur(2px);transform:rotate(30deg) scale(.7)}[data-theme=dark] .ico.moon{opacity:1;filter:blur(0);transform:rotate(0) scale(1)}
.still .ico,.still .iconWrap{transition:none!important}
::view-transition-old(root),::view-transition-new(root){animation:none;mix-blend-mode:normal}::view-transition-new(root){animation:reveal .48s cubic-bezier(.65,0,.35,1)}
@keyframes reveal{from{clip-path:circle(0 at var(--x) var(--y))}to{clip-path:circle(var(--r) at var(--x) var(--y))}}
@media (prefers-reduced-motion:reduce){.ico,.iconWrap{transition:opacity .12s!important;transform:none!important;filter:none!important}}`;
const THEME_BUTTON = `<button class="toggle still" id="theme" type="button"><span class="iconWrap"><span class="ico sun" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg></span><span class="ico moon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg></span></span></button>`;
const THEME_JS = `const root=document.documentElement,btn=document.getElementById('theme');
function label(){const d=root.dataset.theme==='dark';btn.setAttribute('aria-pressed',d);btn.setAttribute('aria-label','Switch to '+(d?'light':'dark')+' mode')}
label();requestAnimationFrame(()=>requestAnimationFrame(()=>btn.classList.remove('still')));
btn.onclick=()=>{const next=root.dataset.theme==='dark'?'light':'dark';const apply=()=>{root.dataset.theme=next;localStorage.theme=next;label()};
if(!document.startViewTransition||matchMedia('(prefers-reduced-motion:reduce)').matches)return apply();
const b=btn.getBoundingClientRect(),x=b.left+b.width/2,y=b.top+b.height/2;root.style.setProperty('--x',x+'px');root.style.setProperty('--y',y+'px');
root.style.setProperty('--r',Math.hypot(Math.max(x,innerWidth-x),Math.max(y,innerHeight-y))+'px');document.startViewTransition(apply)};`;

/** The rubric form for blinded pairs: picks and scores live in localStorage, and download as votes JSON. */
function rubricSection(pairs, storeKey) {
  if (!pairs.length) return '';
  const media = (f) => (VIDEO.has(extname(f).toLowerCase()) ? `<video src="${esc(f)}" controls loop muted playsinline></video>` : `<img src="${esc(f)}" alt="">`);
  const axisSel = (id, side) => AXES.map((a) => `<div class="axisrow"><span>${esc(a)}</span><select data-pair="${id}" data-side="${side}" data-axis="${esc(a)}"><option value="">–</option>${[1, 2, 3, 4, 5].map((n) => `<option>${n}</option>`).join('')}</select></div>`).join('');
  const blocks = pairs
    .map(
      (p) => `<div class="card"><h2>${p.id}</h2><div class="pair"><figure>${media(p.L)}<figcaption>Left</figcaption></figure><figure>${media(p.R)}<figcaption>Right</figcaption></figure></div>
<div class="pick" style="margin-top:10px">Better: <select data-pair="${p.id}" data-pick="1"><option value="">–</option><option value="L">Left</option><option value="R">Right</option><option value="tie">Tie</option></select></div>
<div class="rubric"><div><b>Left</b>${axisSel(p.id, 'L')}</div><div><b>Right</b>${axisSel(p.id, 'R')}</div></div>
<p><input type="text" data-pair="${p.id}" data-notes="1" placeholder="Notes (one line)"></p></div>`,
    )
    .join('');
  const js = `const STORE=${JSON.stringify(storeKey)};const state=JSON.parse(localStorage[STORE]||'{"judge":"","pairs":{}}');
const P=(id)=>(state.pairs[id]??={pick:null,scores:{L:{},R:{}},notes:''});
document.querySelectorAll('[data-pair]').forEach(el=>{const p=P(el.dataset.pair);
 if(el.dataset.pick)el.value=p.pick??'';else if(el.dataset.notes)el.value=p.notes??'';else el.value=p.scores[el.dataset.side][el.dataset.axis]??'';
 el.addEventListener('change',()=>{const q=P(el.dataset.pair);if(el.dataset.pick)q.pick=el.value||null;else if(el.dataset.notes)q.notes=el.value;
  else{const v=parseInt(el.value,10);if(v)q.scores[el.dataset.side][el.dataset.axis]=v;else delete q.scores[el.dataset.side][el.dataset.axis]}localStorage[STORE]=JSON.stringify(state)})});
const judge=document.getElementById('judge');judge.value=state.judge;judge.oninput=()=>{state.judge=judge.value;localStorage[STORE]=JSON.stringify(state)};
document.getElementById('save').onclick=()=>{if(!state.judge){alert('Type your name first');return}
 const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(state,null,1)],{type:'application/json'}));a.download=state.judge.replace(/[^\\w.-]+/g,'-')+'.json';a.click()};`;
  return {
    html: `<section><div class="card"><h2>Blinded pairs</h2><p class="sub">Score both sides 1 (poor) to 5 (ship it) on every axis, then pick the better one or a tie. Your answers stay in this browser; <b>Save votes</b> downloads them: put the file in this folder's <code>votes/</code>.</p>
<p><input type="text" id="judge" placeholder="Your name (the judge)"></p><button class="act" id="save" type="button">Save votes</button></div>${blocks}</section>`,
    js,
  };
}

function page(title, sub, body, js = '') {
  return `<!doctype html><html lang="en"><head>${THEME_HEAD}<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="icon" href="data:,"><style>${CSS}</style></head>
<body><div class="wrap"><header><div><h1>${esc(title)}</h1><div class="sub">${sub}</div></div>${THEME_BUTTON}</header>${body}</div><script>${THEME_JS}\n${js}</script></body></html>`;
}

/** judge-brief.md and judge-template.json for model judges (they get frames, not the page). */
function judgeFiles(dir, pairs, sheets, context) {
  const tpl = { judge: '<your name>', pairs: Object.fromEntries(pairs.map((p) => [p.id, { pick: 'L | R | tie', scores: { L: Object.fromEntries(AXES.map((a) => [a, 0])), R: Object.fromEntries(AXES.map((a) => [a, 0])) }, notes: '' }])) };
  writeFileSync(join(dir, 'judge-template.json'), JSON.stringify(tpl, null, 1));
  const lines = [
    '# Judge brief',
    '',
    context,
    '',
    'For each pair, look at every image for the Left and the Right side. Score each side 1 (poor) to 5 (would ship as is) on every axis, then pick the better side, or `tie`. Return `judge-template.json` filled in (scores as whole numbers 1-5, your name in `judge`, one line of notes per pair if you want). Judge only what you see.',
    '',
    `Axes: ${AXES.join(', ')}.`,
    '',
    ...pairs.flatMap((p) => [`## ${p.id}`, '', `- Left: ${(sheets[p.id]?.L ?? []).join(', ') || 'no frames'}`, `- Right: ${(sheets[p.id]?.R ?? []).join(', ') || 'no frames'}`, '']),
  ];
  writeFileSync(join(dir, 'judge-brief.md'), lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Running the agent CLI

const log = (o) => process.stderr.write(JSON.stringify(o) + '\n');

/** Runs the agent CLI; resolves {ok, json, stderr, code, seconds} (never rejects). */
export function runAgent(agent, args, env = {}) {
  const started = Date.now();
  return new Promise((res) => {
    const child = spawn(process.execPath, [agent, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      let json = null;
      try {
        json = JSON.parse(out);
      } catch {
        json = { ok: false, error: `no JSON from ${args[0]}: ${out.slice(0, 300)} ${err.slice(-300)}` };
      }
      res({ ok: code === 0 && json?.ok !== false, json, stderr: err, code, seconds: Math.round((Date.now() - started) / 100) / 10 });
    });
  });
}

/** An APFS clone of a bundle (instant on macOS), else a plain copy. */
function cloneBundle(src, dst) {
  return new Promise((res) => {
    execFile('/bin/cp', ['-cR', src, dst], (e) => {
      if (e) cpSync(src, dst, { recursive: true });
      res(dst);
    });
  });
}

/** The ffmpeg the app bundles (ffmpeg-static), unless OPENSCREEN_FFMPEG says otherwise; else the one on PATH. */
function ffmpegBin() {
  if (process.env.OPENSCREEN_FFMPEG) return process.env.OPENSCREEN_FFMPEG;
  try {
    const p = createRequire(import.meta.url)('ffmpeg-static');
    if (typeof p === 'string' && existsSync(p)) return p;
  } catch {
    // not installed: fall through to PATH
  }
  return 'ffmpeg';
}

function ffmpeg(args) {
  return new Promise((res) => {
    execFile(ffmpegBin(), ['-hide_banner', ...args], { maxBuffer: 1 << 24 }, (e, _out, err) => res({ ok: !e, stderr: String(err ?? '') }));
  });
}

/** A still's or a clip's display size (a 90° rotation tag swaps it, as ffmpeg's decoder does), or null. */
export async function mediaSize(file) {
  const { stderr } = await ffmpeg(['-i', file]);
  const m = stderr.match(/Stream #\d+:\d+.*Video:.*?\b(\d{1,5})x(\d{1,5})\b/);
  if (!m) return null;
  const turned = Math.abs(Number(stderr.match(/rotation of (-?[\d.]+) degrees/)?.[1] ?? 0)) % 180 === 90;
  return turned ? { w: Number(m[2]), h: Number(m[1]) } : { w: Number(m[1]), h: Number(m[2]) };
}

const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

function mediaIn(p) {
  if (!existsSync(p)) return [];
  if (statSync(p).isFile()) return [resolve(p)];
  return readdirSync(p)
    .filter((f) => IMAGE.has(extname(f).toLowerCase()) || VIDEO.has(extname(f).toLowerCase()))
    .sort()
    .map((f) => resolve(p, f));
}

/** Contact sheets for a video (the CLI's `review`), so model judges can see clips; images are their own sheet. */
async function sheetsFor(agent, file, env) {
  if (!VIDEO.has(extname(file).toLowerCase())) return [file];
  const r = await runAgent(agent, ['review', file, '--no-taps'], env);
  return r.ok ? (r.json.sheets ?? r.json.images?.sheets ?? []).map((s) => (typeof s === 'string' ? s : s.path)) : [];
}

// ---------------------------------------------------------------------------
// build

export async function build(opts) {
  const agent = opts.agent ?? join(HERE, 'openscreen-agent.mjs');
  const src = resolve(opts.bundle);
  if (!existsSync(join(src, 'project.json'))) throw new Usage(`not a bundle (no project.json): ${src}`);
  const name = basename(src).replace(/\.openscreen$/, '');
  const out = resolve(opts.out ?? join('/tmp/openscreen-review', `${name}-${stamp()}`));
  const work = join(out, 'work');
  mkdirSync(work, { recursive: true });
  const env = { OPENSCREEN_RECORDINGS_DIR: work };
  const failures = [];
  const timings = [];
  const step = async (label, args) => {
    log({ step: label });
    const r = await runAgent(agent, args, env);
    timings.push({ step: label, seconds: r.seconds, ok: r.ok });
    if (!r.ok) failures.push({ step: label, error: r.json?.error ?? `exit ${r.code}` });
    return r;
  };
  const clone = (label) => cloneBundle(src, join(work, `${label}.openscreen`));

  const base = await step('info', ['info', src]);
  if (!base.ok) throw new Error(`info failed: ${base.json?.error}`);
  const info = base.json;
  if (info.source?.kind !== 'iosDevice') throw new Usage('the 3D phone needs an iPhone or iPad take');

  // Flat vs 3D (Auto 3D).
  const flat = await clone('flat');
  await step('flat: phone3d clear', ['apply', flat, JSON.stringify([{ op: 'phone3d', clear: true }])]);
  const three = await clone('auto3d');
  const direct = await step(`auto 3D (${opts.style})`, ['direct', three, '--style', opts.style]);
  const info3 = (await step('info (3D)', ['info', three])).json ?? {};
  const D = info3.outputDuration ?? info.outputDuration;
  const clips = info3.clips ?? info.clips ?? [];
  const tapsOut = (info3.taps?.items ?? []).map((t) => sourceToOutput(clips, t.t)).filter((t) => t !== null);
  const waitsOut = (info3.waits ?? [])
    .map((w) => ({ start: sourceToOutput(clips, w.start), end: sourceToOutput(clips, w.end) }))
    .filter((w) => w.start !== null && w.end !== null);
  const shots = direct.ok ? direct.json.shots : [];
  const times = compareTimes(shots, tapsOut, D);
  const draft = opts.draft ? ['--draft'] : [];
  const compare = [];
  let gpuName = null;
  if (times.length) {
    const at = times.join(',');
    const f2 = await step('frames: flat', ['frames', flat, '--at', at, '--out', join(out, 'compare', 'flat'), ...draft]);
    const f3 = await step('frames: 3D', ['frames', three, '--at', at, '--out', join(out, 'compare', '3d'), ...draft]);
    const byT = (r) => new Map((r.json?.files ?? []).filter((f) => f.path).map((f) => [f.t, f]));
    const a = byT(f2);
    const b = byT(f3);
    gpuName = f3.json?.gpu ?? f2.json?.gpu ?? null;
    for (const t of times) compare.push({ t, flat: a.get(t)?.path ?? null, three: b.get(t)?.path ?? null, facing: b.get(t)?.facing ?? null });
  }
  const validate3 = await runAgent(agent, ['validate', three], env);
  const warnings = validate3.json?.warnings ?? direct.json?.warnings ?? [];

  // One short take per recipe.
  const srcTaps = bundleTaps(JSON.parse(readFileSync(join(src, 'project.json'), 'utf8')), info.taps?.items ?? []);
  const srcWaits = info.waits ?? [];
  const lo = info.clips?.[0]?.sourceStart ?? 0;
  const hi = info.clips?.length ? info.clips[info.clips.length - 1].sourceEnd : info.source.duration;
  const recipeDur = Object.fromEntries((info.shotRecipes ?? []).map((r) => [r.name, r.duration]));
  const recipes = [];
  for (const r of RECIPES) {
    const len = Math.max(3, (recipeDur[r] ?? 0) + 1);
    const win = quietWindow(srcTaps, srcWaits, len, lo, Math.max(lo + len, hi));
    const b = await clone(`recipe-${r}`);
    const ops = [{ op: 'trim', start: win.start, end: win.start + len }, { op: 'phone3d', enabled: true }, r === 'float' ? { op: 'shot', recipe: 'float' } : { op: 'shot', recipe: r, at: 0.3 }];
    const ap = await step(`${r}: set up`, ['apply', b, JSON.stringify(ops)]);
    const entry = { recipe: r, ops, len, ok: ap.ok, window: { start: win.start, end: win.start + len, quiet: win.free }, warnings: ap.json?.warnings ?? [], strip: null, files: [], clip: null };
    if (ap.ok) {
      const fr = await step(`${r}: frames`, ['frames', b, '--every', String(Math.round((len / 12) * 1000) / 1000), '--sheet', '--out', join(out, 'recipes', r), ...draft]);
      entry.strip = fr.json?.sheet ?? null;
      entry.files = (fr.json?.files ?? []).filter((f) => f.path);
      entry.framesSeconds = fr.seconds;
      gpuName ??= fr.json?.gpu ?? null;
      if (opts.clips) {
        const ex = await step(`${r}: 3 s clip`, ['export', b, '--out', join(out, 'clips', `${r}.mp4`)]);
        if (ex.ok) entry.clip = ex.json.probe?.file ?? join(out, 'clips', `${r}.mp4`);
        entry.exportSeconds = ex.json?.wallSeconds ?? ex.seconds;
      }
    }
    recipes.push(entry);
  }

  // Blinded pairs against the reference captures. Ours is rendered again for each pair, on the layout preset
  // whose shape is nearest the reference's, at export quality, so the two sides can be put on one canvas.
  let pairsOut = [];
  let sheets = {};
  if (opts.refs) {
    const refs = mediaIn(opts.refs);
    const matched = matchRefs(refs, RECIPES.filter((r) => recipes.find((e) => e.recipe === r && e.ok)));
    const items = [];
    for (const [i, { ref, recipe }] of matched.entries()) {
      const e = recipes.find((x) => x.recipe === recipe);
      // Step labels show on the page: no file names in them.
      const label = `reference ${i + 1}`;
      const isVideo = VIDEO.has(extname(ref).toLowerCase());
      if (isVideo && !opts.clips) {
        failures.push({ step: label, error: 'the reference is a clip but --no-clips makes stills of ours: a clip and a still cannot be blinded' });
        continue;
      }
      const size = await mediaSize(ref);
      if (!size) {
        failures.push({ step: label, error: 'ffmpeg could not read it' });
        continue;
      }
      const preset = nearestShapePreset(size);
      const b = await clone(`pair-${i + 1}-${recipe}`);
      const ap = await step(`${label}: ${recipe} on ${preset}`, ['apply', b, JSON.stringify([{ op: 'layout', presetId: preset }, ...e.ops])]);
      if (!ap.ok) continue;
      let ours = null;
      if (isVideo) {
        const dst = join(work, `pair-${i + 1}.mp4`);
        const ex = await step(`${label}: clip`, ['export', b, '--out', dst]);
        ours = ex.ok ? (ex.json.probe?.file ?? dst) : null;
      } else {
        const t = e.files[Math.floor(e.files.length / 2)]?.t ?? Math.round((e.len / 2) * 1000) / 1000;
        const fr = await step(`${label}: still`, ['frames', b, '--at', String(t), '--out', join(work, `pair-${i + 1}`)]);
        ours = (fr.json?.files ?? []).find((f) => f.path)?.path ?? null;
      }
      if (ours) items.push({ a: { label: 'ref', file: ref }, b: { label: 'ours', file: ours }, note: `${basename(ref)} vs ${recipe} on ${preset}`, kind: isVideo ? 'video' : 'image' });
    }
    const blind = blindPairs(items, opts.seed);
    pairsOut = await placePairs(out, blind.pairs);
    sheets = await pairSheets(agent, pairsOut, env, out);
    writeFileSync(join(out, 'key.json'), JSON.stringify({ seed: opts.seed, ours: 'ours', labels: ['ref', 'ours'], pairs: blind.key }, null, 1));
    judgeFiles(out, pairsOut, sheets, 'Each pair shows a 3D phone mockup from two different tools. Judge the phone itself: its shape, materials, light, shadow, how sharp and readable the screen is, and how it moves.');
    mkdirSync(join(out, 'votes'), { recursive: true });
  }

  const bench = opts.bench && existsSync(opts.bench) ? JSON.parse(readFileSync(opts.bench, 'utf8')) : null;
  const rel = (f) => (f ? relative(out, f) : null);
  const moves = (info3.transitions ?? []).map((m) => ({ start: m.start, end: m.end, label: m.recipe ?? m.easing?.kind ?? 'move', reason: shots.find((s) => Math.abs(s.start - m.start) < 0.02)?.reason }));

  const sec = [];
  sec.push(`<section class="card"><h2>Flat vs 3D (Auto 3D, ${esc(opts.style)})</h2><p class="sub">The same frames rendered flat (left) and 3D (right), at the planned moves and taps. <code>facing</code> 1 = screen straight on.</p><div class="grid">${compare
    .map((c) => `<div><div class="pair">${c.flat ? `<img src="${esc(rel(c.flat))}" alt="flat ${c.t}s">` : '<div>missing</div>'}${c.three ? `<img src="${esc(rel(c.three))}" alt="3D ${c.t}s">` : '<div>missing</div>'}</div><figcaption>${c.t.toFixed(2)} s${c.facing !== null ? ` · facing ${c.facing}` : ''}</figcaption></div>`)
    .join('') || '<p>No frames (no taps and no shots).</p>'}</div></section>`);
  sec.push(`<section class="card"><h2>Auto 3D plan over the taps</h2><p class="sub">Grey bands: waits. Ticks: taps. Blocks: 3D moves (hover for the reason). Dots: warnings. Output seconds, ${esc(D?.toFixed?.(2))} s.</p>${planSvg({ D, taps: tapsOut, waits: waitsOut, moves, warnings })}
<table><tr><th>Shot</th><th>Time</th><th>Reason</th></tr>${shots.map((s) => `<tr><td>${esc(s.recipe)}</td><td>${s.start.toFixed(2)}–${s.end.toFixed(2)} s</td><td>${esc(s.reason)}</td></tr>`).join('') || '<tr><td colspan=3>No shots planned.</td></tr>'}</table></section>`);
  const poster = (e) => e.files[Math.floor(e.files.length / 2)]?.path;
  sec.push(`<section class="card"><h2>Recipes</h2><p class="sub">Each recipe on its own short take: the clip (when made) and a contact strip of 12 frames at export quality.</p>${recipes
    .map((e) => `<h2>${esc(e.recipe)}</h2><div class="recipe">${e.clip ? `<video src="${esc(rel(e.clip))}" ${poster(e) ? `poster="${esc(rel(poster(e)))}" ` : ''}preload="metadata" controls loop muted playsinline></video>` : poster(e) ? `<img src="${esc(rel(poster(e)))}" alt="">` : '<div></div>'}<figure>${e.strip ? `<img src="${esc(rel(e.strip))}" alt="${esc(e.recipe)} strip">` : '<p>No strip.</p>'}<figcaption>source ${e.window.start.toFixed(2)}–${e.window.end.toFixed(2)} s${e.window.quiet ? '' : ' (no tap-free window: taps inside)'} · ${e.warnings.length} warning(s)${e.warnings.length ? `: ${esc(e.warnings.map((w) => w.code).join(', '))}` : ''}</figcaption></figure></div>`)
    .join('')}</section>`);
  sec.push(`<section class="card"><h2>Warnings</h2><table><tr><th></th><th>Code</th><th>At</th><th>Message</th><th>Fix</th></tr>${
    warnings.map((w) => `<tr><td><span class="dot y"></span></td><td>${esc(w.code)}</td><td>${typeof w.at === 'number' ? w.at.toFixed(2) + ' s' : ''}</td><td>${esc(w.message)}</td><td><code>${esc(JSON.stringify(w.fix ?? null))}</code></td></tr>`).join('') ||
    '<tr><td><span class="dot g"></span></td><td colspan=4>No warnings on the Auto 3D project.</td></tr>'
  }</table></section>`);
  const failRows = failures.map((f) => `<tr><td><span class="dot r"></span>${esc(f.step)}</td><td>${esc(f.error)}</td></tr>`).join('');
  sec.push(`<section class="card"><h2>Timings</h2><table><tr><th>Step</th><th>Seconds</th></tr>${timings.map((t) => `<tr><td><span class="dot ${t.ok ? 'g' : 'r'}"></span>${esc(t.step)}</td><td>${t.seconds}</td></tr>`).join('')}</table>${failRows ? `<h2 style="margin-top:14px">Failures</h2><table>${failRows}</table>` : ''}
${bench ? `<h2 style="margin-top:14px">Bench (${esc(opts.bench)})</h2><table><tr><th>Measure</th><th>Value</th><th>Budget</th><th></th></tr>${(bench.checks ?? []).map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.value)}</td><td>${esc(c.budget)}</td><td><span class="dot ${c.pass === true ? 'g' : c.pass === false ? 'r' : 'y'}"></span></td></tr>`).join('')}</table>` : ''}</section>`);
  const rub = rubricSection(pairsOut.map((p) => ({ ...p, L: relative(out, p.L), R: relative(out, p.R) })), `review3d:${out}`);
  if (rub) sec.push(rub.html);

  const html = page(`3D review · ${name}`, `${esc(src)} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · GPU ${esc(gpuName ?? 'unknown')} · ${failures.length ? `<span class="dot r"></span>${failures.length} step(s) failed` : '<span class="dot g"></span>all steps ran'}`, sec.join('\n'), rub?.js ?? '');
  writeFileSync(join(out, 'index.html'), html);
  const result = { ok: failures.length === 0, out, page: join(out, 'index.html'), bundle: src, style: opts.style, shots, compare: compare.length, recipes: recipes.map((e) => ({ recipe: e.recipe, frames: e.files.length, strip: e.strip, clip: e.clip, warnings: e.warnings.length })), warnings: warnings.length, gpu: gpuName, pairs: pairsOut.length, pairShapes: pairsOut.map((p) => ({ id: p.id, ...p.canvas })), key: pairsOut.length ? join(out, 'key.json') : null, failures, timings };
  writeFileSync(join(out, 'review.json'), JSON.stringify(result, null, 1));
  return result;
}

/**
 * Re-encodes both sides of each pair into pairs/ as one container (PNG for stills, H.264 mp4 for clips, no
 * sound, no metadata) at one size and shape (pairCanvas), under names that do not give the side away.
 * A still paired with a clip is refused: the kind alone would tell the sides apart.
 */
async function placePairs(out, pairs) {
  const dir = join(out, 'pairs');
  mkdirSync(dir, { recursive: true });
  const placed = [];
  for (const p of pairs) {
    const video = [p.L, p.R].map((f) => VIDEO.has(extname(f).toLowerCase()));
    if (video[0] !== video[1]) throw new Usage(`${p.id}: one side is a clip and the other a still, so judges could tell them apart; pair clips with clips and stills with stills`);
    const [sl, sr] = await Promise.all([mediaSize(p.L), mediaSize(p.R)]);
    if (!sl || !sr) throw new Error(`${p.id}: ffmpeg could not read ${!sl ? p.L : p.R}`);
    const canvas = pairCanvas(sl, sr);
    const vf = pairFilter(canvas);
    const put = async (f, side) => {
      const dst = join(dir, `${p.id}-${side}${video[0] ? '.mp4' : '.png'}`);
      const enc = video[0]
        ? ['-vf', `${vf},format=yuv420p`, '-an', '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-movflags', '+faststart']
        : ['-vf', `${vf},format=rgb24`, '-frames:v', '1', '-update', '1'];
      const r = await ffmpeg(['-loglevel', 'error', '-y', '-i', f, ...enc, '-map_metadata', '-1', '-fflags', '+bitexact', dst]);
      if (!r.ok) throw new Error(`${p.id}: ffmpeg could not re-encode ${f}: ${r.stderr.trim().slice(-300)}`);
      return dst;
    };
    const L = await put(p.L, 'L');
    const R = await put(p.R, 'R');
    if (canvas.leak) log({ warning: 'pair-shape', pair: p.id, message: `the two sides differ in shape by ${Math.round(canvas.diff * 100)}%: padding shows which is which; crop the reference to the other's shape` });
    placed.push({ ...p, L, R, canvas });
  }
  return placed;
}

async function pairSheets(agent, pairs, env, out) {
  const res = {};
  for (const p of pairs) res[p.id] = { L: (await sheetsFor(agent, p.L, env)).map((f) => relative(out, f)), R: (await sheetsFor(agent, p.R, env)).map((f) => relative(out, f)) };
  return res;
}

// ---------------------------------------------------------------------------
// pairs (the equal test)

export async function pairsCmd(opts) {
  const agent = opts.agent ?? join(HERE, 'openscreen-agent.mjs');
  const a = mediaIn(opts.a);
  const b = mediaIn(opts.b);
  if (!a.length || !b.length) throw new Usage('pairs: --a and --b must each be a clip, a still, or a folder of them');
  if (a.length !== b.length) throw new Usage(`pairs: --a has ${a.length} file(s) and --b has ${b.length}; they pair up in name order`);
  const [la, lb] = opts.labels;
  const out = resolve(opts.out);
  mkdirSync(join(out, 'votes'), { recursive: true });
  const items = a.map((f, i) => ({ a: { label: la, file: f }, b: { label: lb, file: b[i] }, note: `${basename(f)} vs ${basename(b[i])}` }));
  const blind = blindPairs(items, opts.seed);
  const placed = await placePairs(out, blind.pairs);
  const sheets = await pairSheets(agent, placed, {}, out);
  writeFileSync(join(out, 'key.json'), JSON.stringify({ seed: opts.seed, labels: [la, lb], pairs: blind.key }, null, 1));
  judgeFiles(out, placed, sheets, 'Each pair is two edits of the same recording, made for the brief "Make a 15 s world-class 3D promo of this recording". Judge the finished video: the 3D phone, the motion, how readable the screen is at each tap, and whether you would ship it.');
  const rub = rubricSection(placed.map((p) => ({ ...p, L: relative(out, p.L), R: relative(out, p.R) })), `review3d:${out}`);
  writeFileSync(join(out, 'index.html'), page('Blinded comparison', `${placed.length} pair(s) · seed ${opts.seed}`, rub.html, rub.js));
  return { ok: true, out, page: join(out, 'index.html'), pairs: placed.length, pairShapes: placed.map((p) => ({ id: p.id, ...p.canvas })), key: join(out, 'key.json'), note: 'move key.json out of this folder before any judge sees it; put it back for tally' };
}

// ---------------------------------------------------------------------------
// tally

export function tallyCmd(dir, equal) {
  const keyPath = join(dir, 'key.json');
  if (!existsSync(keyPath)) throw new Usage(`tally: ${keyPath} is missing (put the key back in the run folder)`);
  const key = JSON.parse(readFileSync(keyPath, 'utf8'));
  const vdir = join(dir, 'votes');
  const files = existsSync(vdir) ? readdirSync(vdir).filter((f) => f.endsWith('.json')).sort() : [];
  const votes = files.map((f) => {
    const v = JSON.parse(readFileSync(join(vdir, f), 'utf8'));
    return { ...v, judge: v.judge || basename(f, '.json') };
  });
  const result = equal ? tallyEqual(key, votes, equal[0], equal[1]) : tallyLook(key, votes, key.ours ?? 'ours');
  return { ok: true, dir, judgeFiles: files, ...result };
}

// ---------------------------------------------------------------------------
// CLI

export class Usage extends Error {}

export function parseArgs(argv) {
  const args = [...argv];
  const take = (name) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Usage(`${name} needs a value`);
    args.splice(i, 2);
    return v;
  };
  const has = (name) => {
    const i = args.indexOf(name);
    if (i < 0) return false;
    args.splice(i, 1);
    return true;
  };
  const sub = ['pairs', 'tally', 'build'].includes(args[0]) ? args.shift() : 'build';
  const seedRaw = take('--seed');
  const seed = seedRaw === undefined ? (Date.now() % 1e9) : Number(seedRaw);
  if (!Number.isInteger(seed)) throw new Usage('--seed must be an integer');
  let o;
  if (sub === 'tally') {
    const eq = take('--equal');
    const dir = args.shift();
    if (!dir) throw new Usage('usage: review3d.mjs tally <run dir> [--equal a,b]');
    const equal = eq ? eq.split(',') : null;
    if (equal && equal.length !== 2) throw new Usage('--equal takes two labels: a,b');
    o = { sub, dir: resolve(dir), equal };
  } else if (sub === 'pairs') {
    const a = take('--a');
    const b = take('--b');
    const out = take('--out');
    const labels = (take('--labels') ?? 'a,b').split(',');
    const agent = take('--agent');
    if (!a || !b || !out) throw new Usage('usage: review3d.mjs pairs --a <file|dir> --b <file|dir> [--labels a,b] --out dir [--seed n]');
    if (labels.length !== 2 || labels[0] === labels[1]) throw new Usage('--labels takes two different labels: a,b');
    o = { sub, a, b, out, labels, seed, agent };
  } else {
    const out = take('--out');
    const style = take('--style') ?? 'hero';
    const refs = take('--refs');
    const bench = take('--bench');
    const agent = take('--agent');
    const clips = !has('--no-clips');
    const draft = has('--draft');
    const bundle = args.shift();
    if (!bundle) throw new Usage('usage: review3d.mjs <bundle> [--out dir] [--style subtle|hero|bold] [--refs dir] [--no-clips] [--draft] [--bench bench.json] [--seed n]');
    if (!['subtle', 'hero', 'bold'].includes(style)) throw new Usage('--style must be subtle, hero or bold');
    o = { sub, bundle, out, style, refs, bench, agent, clips, draft, seed };
  }
  const extra = args.find(Boolean);
  if (extra) throw new Usage(`unexpected argument "${extra}"`);
  return o;
}

async function main() {
  let result;
  let code = 0;
  try {
    const o = parseArgs(process.argv.slice(2));
    if (o.sub === 'tally') result = tallyCmd(o.dir, o.equal);
    else if (o.sub === 'pairs') result = await pairsCmd(o);
    else result = await build(o);
    code = result.ok ? 0 : 1;
  } catch (e) {
    result = { ok: false, error: e.message };
    code = e instanceof Usage ? 2 : 1;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(code);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
