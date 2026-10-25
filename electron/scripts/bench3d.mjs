#!/usr/bin/env node
// The 3D phone performance bench (SPEC §6.5 with owner decision 10). It runs
// the real app (this checkout's Electron) on clones of a bundle and measures
// through the Chrome DevTools Protocol, the way a person would see it:
//
//   node scripts/bench3d.mjs <bundle> [--out dir] [--seconds 4] [--runs 3] [--no-4k] [--no-preview] [--no-memory] [--port 9441]
//
// - export 1080p and 4K (2160×3840, social-9x16 at exportPreset uhd4k, D18), the phone still and moving: the
//   3D pass per frame (window.__p3d stats, switched on before the page's first script), the samples per frame,
//   engine renders per exported frame (must be 1), WebGL contexts per process (must be 1)
// - GPU memory: the GPU process's physical footprint (macOS `footprint`), peak during a 4K export, 3D minus the
//   same project flat, median of --runs runs; defaults and supersample 2
// - frames: the first PNG cold, then per PNG at 1080p draft and 4K full quality (the agent CLI)
// - a flat project never loads the 3D engine chunk (three.js)
// - preview (opens an editor window for ~20 s; --no-preview skips it): frame rate and the 3D pass while playing,
//   depth of field on and off
//
// The original bundle is only read (APFS clones in <out>/work). Only processes this script starts are stopped.
// Writes <out>/bench.json ({machine, checks:[{name, value, budget, pass}], runs}) and prints it. Budgets are
// for an M1 8 GB; on any other machine the output says so ("not measured on 8 GB").
// Exit 0 when every check passes, 1 when one fails or a step breaks, 2 on bad usage.

import { execFile, execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const E = resolve(HERE, '..');
const AGENT = join(HERE, 'openscreen-agent.mjs');
const MiB = 1024 * 1024;

/** The budgets (SPEC §6.5; owner decision 16 replaces decision 10's speed and memory numbers: quality wins). */
export const BUDGETS = {
  previewFps: 55,
  previewPassMs: 8,
  previewPassDofMs: 8,
  export1080StillMs: 20,
  export1080MovingP95Ms: 120,
  export4kStillMs: 80,
  export4kMovingP95Ms: 800,
  export4kAdaptiveMaxMs: 1500,
  framesColdS: 6,
  framesDraft1080S: 0.25,
  framesFull4kS: 1.5,
  gpu4kMiB: 400,
  gpu4kSs2MiB: 700,
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for test/bench3d.test.ts)

/** Nearest-rank percentile of `xs` (0..1). null for an empty list. */
export function pct(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}
export const median = (xs) => pct(xs, 0.5);
const r1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);
const r3 = (x) => (x === null || x === undefined ? null : Math.round(x * 1000) / 1000);

export function stats(xs) {
  return xs.length ? { n: xs.length, p50: r1(pct(xs, 0.5)), p95: r1(pct(xs, 0.95)), max: r1(Math.max(...xs)) } : null;
}

/** The physical footprint in bytes from `footprint -f bytes -p <pid>` output. */
export function parseFootprint(text) {
  const m = text.match(/Footprint:\s*(\d+)\s*B/);
  return m ? Number(m[1]) : null;
}

/** The GPU process among the descendants of `root` in `ps -Ao pid=,ppid=,command=` output. */
export function gpuPid(psText, root) {
  const rows = psText
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
  const kids = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) if (kids.has(r.ppid) && !kids.has(r.pid)) (kids.add(r.pid), (grew = true));
  }
  return rows.find((r) => kids.has(r.pid) && r.pid !== root && /--type=gpu-process/.test(r.cmd))?.pid ?? null;
}

/** One check row. `pass` is null when the value could not be measured (that is reported, never counted as a pass). */
export function check(name, value, budget, pass, note) {
  return { name, value, budget, pass: value === null || value === undefined ? null : pass, ...(note ? { note } : {}) };
}

/**
 * The checks from the measurements. `m` holds export runs (`e1080still`, `e1080moving`, `e4kstill`, `e4kmoving`,
 * `flat1080`), `memory` ({flat, defaults, ss2}: arrays of peak bytes), `frames` and `preview`.
 */
export function checksFrom(m) {
  const out = [];
  const B = BUDGETS;
  const pass = (r) => r?.passMs ?? [];
  const pe = m.preview;
  if (pe) {
    const fpsCheck = (label, r) => {
      const ceiling = r?.idleFps ?? null;
      if (ceiling !== null && ceiling < B.previewFps) {
        return check(label, null, `≥ ${B.previewFps} fps`, false, `not measurable on this run: the window itself runs at ${ceiling} fps with nothing playing (display refresh or a covered window); playing gave ${r.fps} fps`);
      }
      return check(label, r?.fps ?? null, `≥ ${B.previewFps} fps`, (r?.fps ?? 0) >= B.previewFps);
    };
    out.push(fpsCheck('preview 1080×1920 frame rate (DoF on)', pe.dof));
    out.push(check('preview 3D pass p95 (DoF on)', pe.dof?.pass?.p95 ?? null, `≤ ${B.previewPassDofMs} ms`, (pe.dof?.pass?.p95 ?? Infinity) <= B.previewPassDofMs));
    out.push(fpsCheck('preview 1080×1920 frame rate (DoF off)', pe.plain));
    out.push(check('preview 3D pass p95 (DoF off)', pe.plain?.pass?.p95 ?? null, `≤ ${B.previewPassMs} ms`, (pe.plain?.pass?.p95 ?? Infinity) <= B.previewPassMs));
  }
  const ex = (key, label, budget, p, size) => {
    const r = m[key];
    if (!r) return;
    const xs = pass(r);
    const v = r1(pct(xs, p));
    out.push(check(`${label} 3D pass ${p === 0.5 ? 'p50' : 'p95'}`, v, `≤ ${budget} ms`, v !== null && v <= budget));
    if (size) out.push(check(`${label} canvas`, r.canvas ? `${r.canvas.w}×${r.canvas.h}` : null, size, r.canvas ? `${r.canvas.w}×${r.canvas.h}` === size : false));
  };
  ex('e1080still', 'export 1080p still', B.export1080StillMs, 0.5, '1080×1920');
  ex('e1080moving', 'export 1080p moving', B.export1080MovingP95Ms, 0.95);
  ex('e4kstill', 'export 4K still', B.export4kStillMs, 0.5, '2160×3840');
  ex('e4kmoving', 'export 4K moving (all frames)', B.export4kMovingP95Ms, 0.95);
  if (m.e4kmoving) {
    const adaptive = m.e4kmoving.frames3d.filter((f) => f.samples > m.e4kmoving.baseSamples).map((f) => f.ms);
    out.push(check('export 4K moving, adaptive-N frames max', adaptive.length ? r1(Math.max(...adaptive)) : 0, `≤ ${B.export4kAdaptiveMaxMs} ms`, !adaptive.length || Math.max(...adaptive) <= B.export4kAdaptiveMaxMs, `${adaptive.length} frame(s) took more than ${m.e4kmoving.baseSamples} samples`));
  }
  for (const key of ['e1080still', 'e1080moving', 'e4kstill', 'e4kmoving']) {
    const r = m[key];
    if (!r) continue;
    out.push(check(`${key}: engine renders per exported frame`, r.frames ? r3(r.renders / r.frames) : null, 'exactly 1', r.frames > 0 && r.renders === r.frames, `${r.renders} renders, ${r.frames} frames`));
    out.push(check(`${key}: WebGL contexts`, r.contexts, 'exactly 1', r.contexts === 1));
  }
  // The control for the check below: the detector does see the chunk when a 3D export loads it.
  if (m.e1080still) out.push(check('3D export: 3D engine chunk loaded (detector control)', m.e1080still.engineLoaded === null || m.e1080still.engineLoaded === undefined ? null : m.e1080still.engineLoaded ? 'loaded' : 'not loaded', 'loaded', m.e1080still.engineLoaded === true));
  if (m.flat1080) out.push(check('flat project: 3D engine chunk not loaded', m.flat1080.engineLoaded === null ? null : m.flat1080.engineLoaded ? 'loaded' : 'not loaded', 'not loaded', m.flat1080.engineLoaded === false));
  if (m.frames) {
    const f = m.frames;
    out.push(check('frames: first PNG, cold', f.coldS, `≤ ${B.framesColdS} s`, f.coldS !== null && f.coldS <= B.framesColdS));
    const noise = (r) => (r?.noise ? 'the n-PNG run was not slower than the 1-PNG run (machine noise): run again on a quiet machine' : undefined);
    out.push(check('frames: per PNG, 1080p draft', f.draft1080S, `≤ ${B.framesDraft1080S} s`, f.draft1080S !== null && f.draft1080S <= B.framesDraft1080S, noise(f.draftRuns)));
    if (f.full4kS !== undefined) out.push(check('frames: per PNG, 4K full', f.full4kS, `≤ ${B.framesFull4kS} s`, f.full4kS !== null && f.full4kS <= B.framesFull4kS, noise(f.full4kRuns)));
  }
  if (m.memory) {
    const flat = median(m.memory.flat);
    const mem = (label, xs, budget) => {
      const v = xs.length && flat !== null ? r1((median(xs) - flat) / MiB) : null;
      out.push(check(label, v, `≤ ${budget} MiB`, v !== null && v <= budget, `GPU process peak footprint during a 4K export, 3D minus flat, median of ${xs.length}; 3D peak ${xs.length ? r1(median(xs) / MiB) : '?'} MiB, flat ${flat !== null ? r1(flat / MiB) : '?'} MiB`));
    };
    mem('GPU memory, 4K defaults', m.memory.defaults, B.gpu4kMiB);
    if (m.memory.ss2) mem('GPU memory, 4K supersample 2', m.memory.ss2, B.gpu4kSs2MiB);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CDP

/** A Chrome DevTools Protocol connection (Node's built-in WebSocket), with flat sessions. */
export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) for (const h of this.handlers) h(msg);
    };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = () => rej(new Error(`cannot connect to ${url}`)))));
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      try {
        this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (e) {
        this.pending.delete(id);
        rej(e);
      }
    });
  }
  on(fn) {
    this.handlers.push(fn);
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

/** Runs before the page's first script: stats on, every engine render and every new WebGL context reported on the console. */
export const INJECT = `globalThis.__p3dStatsOn = true;
(() => {
  const rec = { n: 0, ms: [], _last: null };
  Object.defineProperty(rec, 'last', { get() { return this._last; }, set(v) { this._last = v; try { console.debug('__p3d ' + JSON.stringify({ ms: v.lastMs, samples: v.samples, nMotion: v.nMotion, tiles: v.tiles, W: v.W, H: v.H, ss: v.ss, gpuBytes: v.gpuBytes, gpu: v.gpu })); } catch (e) {} } });
  globalThis.__p3d = rec;
  const orig = HTMLCanvasElement.prototype.getContext;
  const seen = new WeakSet();
  let n = 0;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const c = orig.call(this, type, ...rest);
    if (c && /webgl/.test(String(type)) && !seen.has(c)) { seen.add(c); n++; console.debug('__p3dctx ' + n); }
    return c;
  };
})();`;

async function waitForPort(port, ms, alive) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive()) throw new Error('the app exited before its debugging port opened');
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(25);
  }
  throw new Error(`no debugging port ${port} after ${ms} ms`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Launches this checkout's Electron with `args` and a debugging port, attaches to every page before it runs, and
 * collects the __p3d console lines, WebGL context count, every script URL, and (optionally) the GPU process's peak
 * footprint. Resolves when the process exits (or `until` resolves, then it is stopped).
 */
async function instrumented(args, { port, env = {}, sampleGpu = false, until = null, onSession = null }) {
  const bin = join(E, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  if (!existsSync(bin)) throw new Error(`no Electron at ${bin}`);
  if (!existsSync(join(E, 'dist', 'main', 'index.js'))) throw new Error('the app is not built: run npm run build in electron/');
  const child = spawn(bin, [E, ...args, `--remote-debugging-port=${port}`], { env: { ...process.env, ...env, ELECTRON_ENABLE_LOGGING: '' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let exited = false;
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', () => {});
  const done = new Promise((res) => child.on('close', (code) => ((exited = true), res(code))));
  const got = { frames3d: [], contexts: 0, scripts: [], late: false, gpuPeak: null, sessions: [] };
  let cdp = null;
  let gpuTimer = null;
  try {
    const wsUrl = await waitForPort(port, 20000, () => !exited);
    cdp = await Cdp.connect(wsUrl);
    cdp.on((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        const s = msg.params.args?.[0]?.value;
        if (typeof s !== 'string') return;
        if (s.startsWith('__p3d ')) got.frames3d.push(JSON.parse(s.slice(6)));
        else if (s.startsWith('__p3dctx ')) got.contexts = Math.max(got.contexts, Number(s.slice(9)));
      } else if (msg.method === 'Debugger.scriptParsed' && msg.params.url) got.scripts.push(msg.params.url);
      else if (msg.method === 'Target.attachedToTarget' && msg.params.targetInfo.type === 'page') {
        const sid = msg.params.sessionId;
        got.sessions.push(sid);
        if (!msg.params.waitingForDebugger) got.late = true;
        (async () => {
          await cdp.send('Runtime.enable', {}, sid);
          await cdp.send('Debugger.enable', {}, sid);
          await cdp.send('Page.enable', {}, sid);
          await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT }, sid);
          if (got.late) await cdp.send('Runtime.evaluate', { expression: INJECT }, sid);
          await cdp.send('Runtime.runIfWaitingForDebugger', {}, sid);
          if (onSession) onSession(cdp, sid);
        })().catch(() => {});
      }
    });
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    if (sampleGpu) {
      gpuTimer = setInterval(() => {
        try {
          const pid = gpuPid(execFileSync('/bin/ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 1 << 24 }), child.pid);
          if (!pid) return;
          const b = parseFootprint(execFileSync('/usr/bin/footprint', ['-f', 'bytes', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
          if (b !== null) got.gpuPeak = Math.max(got.gpuPeak ?? 0, b);
        } catch {
          /* the process is between states */
        }
      }, 400);
    }
    if (until) {
      await until(cdp, got);
      // The editor may hold a quit for a question (unsaved edits); this copy is scratch, so it is stopped outright.
      for (const sig of ['SIGTERM', 'SIGKILL']) {
        try {
          process.kill(-child.pid, sig);
        } catch {
          /* gone */
        }
        if (await Promise.race([done.then(() => true), sleep(3000).then(() => false)])) break;
      }
    }
    const code = await Promise.race([done, sleep(30 * 60 * 1000).then(() => 'timeout')]);
    got.code = code;
  } finally {
    if (gpuTimer) clearInterval(gpuTimer);
    if (cdp) cdp.close();
    if (!exited) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
  const final = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{') && l.includes('"ok"')).pop();
  got.result = final ? JSON.parse(final) : null;
  return got;
}

/** A headless export with the 3D stats on. */
async function exportRun(bundle, out, port, { sampleGpu = false } = {}) {
  const started = Date.now();
  const g = await instrumented(['--export', bundle, '--out', out], { port, sampleGpu });
  const r = g.result ?? { ok: false, error: `no result (exit ${g.code})` };
  const f = g.frames3d;
  return {
    ok: !!r.ok,
    error: r.ok ? undefined : r.error,
    frames: r.frames ?? null,
    wallSeconds: r1((Date.now() - started) / 1000),
    renders: f.length,
    passMs: f.map((x) => x.ms),
    frames3d: f.map((x) => ({ ms: x.ms, samples: x.samples, tiles: x.tiles })),
    canvas: f.length ? { w: f[0].W, h: f[0].H } : null,
    gpu: f[0]?.gpu ?? r.gpu ?? null,
    contexts: g.contexts,
    lateAttach: g.late,
    // Debugger.enable replays every script already parsed, so a late attach still sees the engine chunk if it loaded
    // before; a page that never attached gives null (not measured).
    engineLoaded: g.sessions.length ? g.scripts.some((u) => /\/engine-[\w-]+\.js$/.test(u)) : null,
    scripts: g.scripts.length,
    gpuPeak: g.gpuPeak,
  };
}

// ---------------------------------------------------------------------------
// The CLI and bundles

function agent(args, env) {
  return new Promise((res) => {
    const started = Date.now();
    execFile(process.execPath, [AGENT, ...args], { env: { ...process.env, ...env }, maxBuffer: 1 << 26 }, (e, stdout) => {
      let json;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = { ok: false, error: `no JSON from ${args[0]}: ${String(stdout).slice(0, 200)} ${e?.message ?? ''}` };
      }
      res({ ok: !e && json.ok !== false, json, seconds: (Date.now() - started) / 1000 });
    });
  });
}

function clone(src, dst) {
  return new Promise((res) => execFile('/bin/cp', ['-cR', src, dst], (e) => (e ? (cpSync(src, dst, { recursive: true }), res(dst)) : res(dst))));
}

export function parseArgs(argv) {
  const args = [...argv];
  const take = (n) => {
    const i = args.indexOf(n);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Usage(`${n} needs a value`);
    args.splice(i, 2);
    return v;
  };
  const has = (n) => {
    const i = args.indexOf(n);
    if (i < 0) return false;
    args.splice(i, 1);
    return true;
  };
  const o = {
    out: take('--out'),
    seconds: Number(take('--seconds') ?? 4),
    runs: Number(take('--runs') ?? 3),
    port: Number(take('--port') ?? 9441),
    k4: !has('--no-4k'),
    preview: !has('--no-preview'),
    memory: !has('--no-memory'),
  };
  o.bundle = args.shift();
  if (!o.bundle) throw new Usage('usage: bench3d.mjs <bundle> [--out dir] [--seconds 4] [--runs 3] [--no-4k] [--no-preview] [--no-memory] [--port 9441]');
  if (args.length) throw new Usage(`unexpected argument "${args[0]}"`);
  if (!(o.seconds >= 3.5 && o.seconds <= 30)) throw new Usage('--seconds must be 3.5..30 (the moving take holds a 3.2 s turn-to-back)');
  if (!(Number.isInteger(o.runs) && o.runs >= 1 && o.runs <= 9)) throw new Usage('--runs must be an integer 1..9');
  if (!(Number.isInteger(o.port) && o.port > 1024 && o.port < 65536)) throw new Usage('--port must be a free TCP port number');
  return o;
}

export class Usage extends Error {}

const log = (o) => process.stderr.write(JSON.stringify(o) + '\n');

export async function bench(o) {
  const src = resolve(o.bundle);
  if (!existsSync(join(src, 'project.json'))) throw new Usage(`not a bundle: ${src}`);
  // Other work on the machine skews every timing: the 1-minute load average at the start and the end is recorded.
  const load0 = loadavg()[0];
  const stampNow = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = resolve(o.out ?? join('/tmp/openscreen-bench', `${basename(src).replace(/\.openscreen$/, '')}-${stampNow}`));
  const work = join(out, 'work');
  mkdirSync(work, { recursive: true });
  const env = { OPENSCREEN_RECORDINGS_DIR: work };
  const errors = [];
  const must = async (label, args) => {
    const r = await agent(args, env);
    if (!r.ok) throw new Error(`${label}: ${r.json.error}`);
    return r.json;
  };

  // Bundles: a short take on the social 9:16 layout; flat, still (3D defaults) and moving (a turn-to-back).
  const info = await must('info', ['info', src]);
  if (info.source?.kind !== 'iosDevice') throw new Usage('the bench needs an iPhone or iPad take');
  const s0 = info.clips?.[0]?.sourceStart ?? 0;
  const base = await clone(src, join(work, 'base.openscreen'));
  await must('trim', ['apply', base, JSON.stringify([{ op: 'trim', start: s0, end: s0 + o.seconds }, { op: 'layout', presetId: 'social-9x16' }, { op: 'exportSettings', preset: 'p1080' }])]);
  const variant = async (name, ops) => {
    const b = await clone(base, join(work, `${name}.openscreen`));
    await must(name, ['apply', b, JSON.stringify(ops)]);
    return b;
  };
  const still = [{ op: 'phone3d', enabled: true }, { op: 'clearTransitions' }];
  const moving = [{ op: 'phone3d', enabled: true }, { op: 'shot', recipe: 'turn-to-back', at: 0.2 }];
  const k4 = { op: 'exportSettings', preset: 'uhd4k' };
  const B = {
    flat1080: await variant('flat1080', [{ op: 'phone3d', clear: true }]),
    e1080still: await variant('e1080still', still),
    e1080moving: await variant('e1080moving', moving),
    ...(o.k4
      ? {
          e4kstill: await variant('e4kstill', [...still, k4]),
          e4kmoving: await variant('e4kmoving', [...moving, k4]),
          flat4k: await variant('flat4k', [{ op: 'phone3d', clear: true }, k4]),
          ss2_4k: await variant('ss2_4k', [...moving, { op: 'phone3d', supersample: 2 }, k4]),
        }
      : {}),
  };
  const baseSamples = 12;

  const m = {};
  let port = o.port;
  for (const key of ['flat1080', 'e1080still', 'e1080moving', ...(o.k4 ? ['e4kstill', 'e4kmoving'] : [])]) {
    log({ step: `export ${key}` });
    const r = await exportRun(B[key], join(out, `${key}.mp4`), port++);
    if (!r.ok) errors.push(`export ${key}: ${r.error}`);
    m[key] = { ...r, baseSamples };
  }

  if (o.k4 && o.memory) {
    m.memory = { flat: [], defaults: [], ss2: [] };
    for (let i = 0; i < o.runs; i++) {
      for (const [key, slot] of [['flat4k', 'flat'], ['e4kmoving', 'defaults'], ['ss2_4k', 'ss2']]) {
        log({ step: `memory ${slot} run ${i + 1}/${o.runs}` });
        const r = await exportRun(B[key], join(out, `mem-${slot}-${i}.mp4`), port++, { sampleGpu: true });
        if (!r.ok) errors.push(`memory ${slot}: ${r.error}`);
        else if (r.gpuPeak) m.memory[slot].push(r.gpuPeak);
      }
    }
  }

  // frames through the CLI. Every run is a fresh app process, so the cost per PNG is the difference between an
  // n-PNG run and a 1-PNG run of the same bundle at the same quality, taken back to back; cold = the first 1-PNG run.
  log({ step: 'frames' });
  const fr = {};
  const perPng = async (bundle, quality, n, label) => {
    const q = quality === 'draft' ? ['--draft'] : [];
    const one = await agent(['frames', bundle, '--at', '1', ...q, '--out', join(out, `frames-${label}-1`)], env);
    const many = await agent(['frames', bundle, '--every', String(r3(o.seconds / n)), ...q, '--out', join(out, `frames-${label}-n`)], env);
    if (!one.ok || !many.ok) {
      errors.push(`frames ${label}: ${(one.ok ? many : one).json.error}`);
      return { one: null, per: null };
    }
    const k = many.json.files.filter((f) => f.path).length;
    const per = (many.json.seconds - one.json.seconds) / Math.max(1, k - 1);
    return { one: r3(one.json.seconds), per: per > 0 ? r3(per) : null, n: k, noise: per <= 0 };
  };
  const d = await perPng(B.e1080moving, 'draft', 20, 'draft1080');
  fr.coldS = d.one;
  fr.draft1080S = d.per;
  fr.draftRuns = d;
  if (o.k4) {
    const k = await perPng(B.e4kmoving, 'full', 6, 'full4k');
    fr.full4kS = k.per;
    fr.full4kRuns = k;
  }
  m.frames = fr;

  if (o.preview) {
    log({ step: 'preview (an editor window opens for about 20 s)' });
    try {
      m.preview = await previewRun(B.e1080moving, port++, out, env);
    } catch (e) {
      errors.push(`preview: ${e.message}`);
    }
  }

  const mem = totalmem();
  const machine = { loadAverage: { start: r1(load0), end: r1(loadavg()[0]) }, cpu: cpus()[0]?.model ?? 'unknown', memoryGB: Math.round(mem / 2 ** 30), gpu: m.e1080still?.gpu ?? null, note: Math.round(mem / 2 ** 30) === 8 ? 'measured on 8 GB' : 'not measured on 8 GB (the budgets are for an M1 8 GB)' };
  const checks = checksFrom(m);
  const summary = { pass: checks.filter((c) => c.pass === true).length, fail: checks.filter((c) => c.pass === false).length, notMeasured: checks.filter((c) => c.pass === null).length };
  const result = {
    ok: errors.length === 0 && summary.fail === 0 && summary.notMeasured === 0,
    out,
    machine,
    seconds: o.seconds,
    summary,
    checks,
    errors,
    raw: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v && typeof v === 'object' && 'passMs' in v ? { ...v, passMs: stats(v.passMs), frames3d: undefined } : v])),
  };
  writeFileSync(join(out, 'bench.json'), JSON.stringify(result, null, 1));
  return result;
}

/** Opens the moving take in the editor, plays it with DoF on, then off (applied live from the CLI), and measures. */
export async function previewRun(bundle, port, out, env) {
  const res = {};
  const g = await instrumented(['--open', bundle], {
    port,
    env: { ...env, OPENSCREEN_USER_DATA: join(out, 'profile') },
    until: async (cdp, got) => {
      const deadline = Date.now() + 30000;
      while (!got.sessions.length && Date.now() < deadline) await sleep(100);
      const sid = got.sessions[0];
      if (!sid) throw new Error('no editor page');
      log({ preview: 'attached' });
      const ev = async (expression) => (await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sid)).result?.value;
      // Wait for the editor's canvas and the 3D engine (the first 3D render).
      while (Date.now() < deadline && !got.frames3d.length) await sleep(200);
      if (!got.frames3d.length) throw new Error('the editor drew no 3D frame within 30 s');
      log({ preview: 'first 3D frame' });
      const rafFor = (ms) => `new Promise((done) => { const xs = []; let last = performance.now(); const end = last + ${ms}; const f = (t) => { xs.push(t - last); last = t; if (t < end) requestAnimationFrame(f); else done(xs); }; requestAnimationFrame(f); })`;
      const play = async (label) => {
        await sleep(1500);
        // The window's own frame rate with nothing playing: the ceiling this run can measure (display, occlusion).
        const idle = ((await ev(rafFor(1000))) ?? []).slice(2);
        const ok = await ev(`(() => { const v = [...document.querySelectorAll('video')].sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0]; if (!v) return false; v.currentTime = 0; return v.play().then(() => true, () => false); })()`);
        if (!ok) throw new Error('could not start playback');
        log({ preview: `playing (${label})` });
        const from = got.frames3d.length;
        const intervals = await ev(rafFor(3000));
        await ev(`document.querySelectorAll('video').forEach((v) => v.pause())`);
        const drawn = got.frames3d.slice(from);
        // Live preview frames are one sample; the paused-idle frame renders at export quality and is reported apart.
        const passes = drawn.filter((x) => x.samples === 1).map((x) => x.ms);
        const xs = (intervals ?? []).slice(2);
        res[label] = {
          fps: xs.length ? r1(1000 / median(xs)) : null,
          idleFps: idle.length ? r1(1000 / median(idle)) : null,
          frameMs: stats(xs),
          renders3d: drawn.length,
          livePerSecond: r1(passes.length / 3),
          pass: stats(passes),
          fullQualityRenders: stats(drawn.filter((x) => x.samples > 1).map((x) => x.ms)),
          canvas: got.frames3d.at(-1) ? { w: got.frames3d.at(-1).W, h: got.frames3d.at(-1).H } : null,
        };
      };
      await play('dof');
      const off = await agent(['apply', bundle, JSON.stringify([{ op: 'phone3d', dof: { on: false } }])], env);
      if (!off.ok) throw new Error(`DoF off: ${off.json.error}`);
      await sleep(2500); // the editor reloads project.json within about a second
      await play('plain');
      res.contexts = got.contexts;
    },
  });
  if (!res.dof) throw new Error(`preview did not run (exit ${g.code})`);
  return res;
}

async function main() {
  let result;
  let code = 0;
  try {
    result = await bench(parseArgs(process.argv.slice(2)));
    code = result.ok ? 0 : 1;
  } catch (e) {
    result = { ok: false, error: e.message };
    code = e instanceof Usage ? 2 : 1;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(code);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
