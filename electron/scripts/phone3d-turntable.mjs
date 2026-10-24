#!/usr/bin/env node
// Look-development turntable for the 3D phone (WP4a, spec §7).
//
// Renders the procedural phone (renderer/src/phone3d/{geometry,materials,
// environment}.ts) with the real GPU in this checkout's Electron, through the
// same colour pipeline the engine uses (D3): a 2-attachment MSAA HalfFloat
// target (lit HDR in 0, the screen in 1), 8 jittered samples averaged in
// HDR, then one output pass (NeutralToneMapping on the lit part, the screen
// added untouched, unpremultiply, sRGB, premultiply). Each still is
// composited over a flat background and written as a PNG; one contact sheet
// per model, and an index.html to look at them side by side.
//
//   node scripts/phone3d-turntable.mjs [--out DIR] [--models id,id] [--finishes all|auto|id,id]
//        [--angles front,threeq,side,backthreeq,back,hero] [--size 900x1200] [--bg #hex]
//        [--preset studio] [--azimuth -35] [--glass 0.25] [--screen image.png] [--ref image]
//        [--samples 8] [--sheet-scale 0.5] [--show]
//
// Defaults: 17 Pro, 16, Air and SE; for each, its darkest, lightest and most
// saturated finish ("black, silver, orange"); six angles. --show keeps the
// render window visible (debugging). One sheet-<model>.png per model: rows
// are finishes, columns the angles.
// Writes only under --out (default: <tmp>/openscreen-turntable). Never
// touches recordings or the installed app.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function parseArgs(argv) {
  const o = {
    out: join(tmpdir(), 'openscreen-turntable'),
    models: ['iphone-17-pro', 'iphone-16', 'iphone-air', 'iphone-se-3'],
    finishes: 'auto',
    angles: ['front', 'threeq', 'side', 'backthreeq', 'back', 'hero'],
    size: [900, 1200],
    bg: '#6a2cf0',
    preset: 'studio',
    azimuth: -35,
    glass: 0.25,
    intensity: 1,
    screen: null,
    ref: null,
    samples: 8,
    sheetScale: 0.5,
    open: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${a} needs a value`);
      return x;
    };
    if (a === '--out') o.out = resolve(v());
    else if (a === '--models') o.models = v().split(',');
    else if (a === '--finishes') o.finishes = v();
    else if (a === '--angles') o.angles = v().split(',');
    else if (a === '--size') o.size = v().split('x').map(Number);
    else if (a === '--bg') o.bg = v();
    else if (a === '--preset') o.preset = v();
    else if (a === '--azimuth') o.azimuth = Number(v());
    else if (a === '--glass') o.glass = Number(v());
    else if (a === '--intensity') o.intensity = Number(v());
    else if (a === '--screen') o.screen = resolve(v());
    else if (a === '--ref') o.ref = resolve(v());
    else if (a === '--samples') o.samples = Number(v());
    else if (a === '--sheet-scale') o.sheetScale = Number(v());
    else if (a === '--show') o.open = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).join('\n') + '\n');
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

/** The page: bundled by esbuild with three and the WP4a modules. */
const ENTRY = String.raw`
import {
  Color, GLSL3, Group, HalfFloatType, LinearSRGBColorSpace, Mesh, NoBlending, CustomBlending, OneFactor, AddEquation,
  NoToneMapping, OrthographicCamera, PerspectiveCamera, PlaneGeometry, Scene, ShaderMaterial, SRGBColorSpace,
  CanvasTexture, LinearMipmapLinearFilter, LinearFilter, WebGLRenderer, WebGLRenderTarget, Euler, MathUtils,
} from 'three';
import { DEVICES, getDevice } from '@src/shared/devices';
import { body3dFor } from '@src/shared/devices3d';
import { frameRectForScreen } from '@src/shared/deviceGeometry';
import { drawCutouts } from '@src/renderer/src/mobile/deviceFrame';
import { phoneModel } from '@src/renderer/src/phone3d/geometry';
import { applyMaterials, materialsForDevice, setEnvIntensity, setScreenMap } from '@src/renderer/src/phone3d/materials';
import { aimStudio, studioEnv, studioLights } from '@src/renderer/src/phone3d/environment';

const ANGLES = {
  front: { turn: 0, tilt: 0, rotate: 0 },
  threeq: { turn: 32, tilt: 8, rotate: -4 },
  side: { turn: 78, tilt: 6, rotate: 0 },
  backthreeq: { turn: 152, tilt: 10, rotate: 6 },
  back: { turn: 180, tilt: 0, rotate: 0 },
  hero: { turn: -24, tilt: 22, rotate: -10 },
};

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const renderer = new WebGLRenderer({ canvas, alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true, reversedDepthBuffer: true });
renderer.toneMapping = NoToneMapping;
renderer.autoClear = false;
renderer.setPixelRatio(1);
const reversed = renderer.state.buffers.depth.getReversed();

const quad = new Mesh(new PlaneGeometry(2, 2));
const quadScene = new Scene();
quadScene.add(quad);
const quadCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

// Accumulate both attachments with a weight (additive, HDR).
const accumMat = new ShaderMaterial({
  glslVersion: GLSL3,
  uniforms: { t0: { value: null }, t1: { value: null }, w0: { value: 1 }, w1: { value: 1 } },
  vertexShader: 'out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: [
    'precision highp float;',
    'in vec2 vUv; uniform sampler2D t0; uniform sampler2D t1; uniform float w0; uniform float w1;',
    'layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1;',
    'void main() { o0 = texture(t0, vUv) * w0; o1 = texture(t1, vUv) * w1; }',
  ].join('\n'),
  blending: CustomBlending, blendEquation: AddEquation, blendSrc: OneFactor, blendDst: OneFactor,
  blendEquationAlpha: AddEquation, blendSrcAlpha: OneFactor, blendDstAlpha: OneFactor,
  depthTest: false, depthWrite: false,
});

// The output pass of §3.5.
const outputMat = new ShaderMaterial({
  uniforms: { t0: { value: null }, t1: { value: null } },
  dithering: true,
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: [
    '#include <common>',
    '#include <tonemapping_pars_fragment>',
    '#include <dithering_pars_fragment>',
    'varying vec2 vUv; uniform sampler2D t0; uniform sampler2D t1;',
    'void main() {',
    '  vec4 a0 = texture2D(t0, vUv); vec4 a1 = texture2D(t1, vUv);',
    '  vec3 c = NeutralToneMapping(a0.rgb) + a1.rgb; float a = a0.a;',
    '  vec3 u = a > 0.0 ? c / a : vec3(0.0);',
    '  u = sRGBTransferOETF(vec4(u, 1.0)).rgb;',
    '  u += dithering(vec3(0.0)) * (1.0 - a1.a);',
    '  gl_FragColor = vec4(clamp(u, 0.0, 1.0) * a, a);',
    '}',
  ].join('\n'),
  blending: NoBlending, depthTest: false, depthWrite: false,
});

let targets = null;
function ensureTargets(w, h) {
  if (targets && targets.w === w && targets.h === h) return targets;
  if (targets) { targets.ms.dispose(); targets.acc.dispose(); }
  const ms = new WebGLRenderTarget(w, h, { count: 2, samples: 4, type: HalfFloatType, depthBuffer: true });
  const acc = new WebGLRenderTarget(w, h, { count: 2, type: HalfFloatType, depthBuffer: false });
  for (const rt of [ms, acc]) for (const t of rt.textures) { t.colorSpace = LinearSRGBColorSpace; t.minFilter = LinearFilter; t.magFilter = LinearFilter; t.generateMipmaps = false; }
  targets = { w, h, ms, acc };
  return targets;
}

const halton = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };

let screenImage = null;
const screenCache = new Map();
function screenTexture(device) {
  const hit = screenCache.get(device.id);
  if (hit) return hit;
  const w = device.screenPx.width, h = device.screenPx.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (screenImage) {
    // Cover-fit the frame into the panel.
    const s = Math.max(w / screenImage.width, h / screenImage.height);
    const dw = screenImage.width * s, dh = screenImage.height * s;
    ctx.drawImage(screenImage, (w - dw) / 2, (h - dh) / 2, dw, dh);
  } else {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#1b2a6b'); g.addColorStop(1, '#c43b7a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }
  drawCutouts(ctx, frameRectForScreen({ x: 0, y: 0, w, h }, device, 'portrait'), device, { orientation: 'portrait' });
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  screenCache.set(device.id, tex);
  return tex;
}

function hexToLinear(hex) { const c = new Color().setStyle(hex); return [c.r, c.g, c.b]; }

/** One still: returns a PNG data URL of the phone over the background. */
window.renderStill = async function (job) {
  const device = getDevice(job.model);
  if (!device) throw new Error('unknown model ' + job.model);
  const finish = device.finishes.find((f) => f.id === job.finish) || device.finishes[0];
  const body = body3dFor(device);
  const { group } = phoneModel(device, body);
  const mats = materialsForDevice(device, body, finish.hex, job.back || 'auto', job.glass, { reversedDepth: reversed });
  applyMaterials(group, mats);
  setScreenMap(mats, screenTexture(device));
  setEnvIntensity(mats, job.intensity);

  const W = job.size[0], H = job.size[1];
  renderer.setSize(W, H, false);
  const t = ensureTargets(W, H);

  const scene = new Scene();
  const pose = Object.assign({ turn: 0, tilt: 0, rotate: 0 }, ANGLES[job.angle] || job.pose || {});
  const holder = new Group();
  holder.rotation.copy(new Euler(MathUtils.degToRad(-pose.tilt), MathUtils.degToRad(pose.turn), MathUtils.degToRad(-pose.rotate), 'ZXY'));
  holder.add(group);
  scene.add(holder);
  const long = Math.max(device.bodyMm.width, device.bodyMm.height);
  const lights = studioLights(job.preset, long, job.intensity);
  scene.add(lights);
  scene.environment = studioEnv(renderer, job.preset, hexToLinear(job.bg));
  aimStudio(lights, scene, job.azimuth);

  const fov = job.fov || 22;
  const cam = new PerspectiveCamera(fov, W / H, 1, 10000);
  const fill = job.fill || 0.78;
  const dist = (device.bodyMm.height / fill) / 2 / Math.tan(MathUtils.degToRad(fov / 2));
  cam.position.set(0, 0, dist + body.depthMm / 2);
  cam.near = dist * 0.5; cam.far = dist * 2;
  cam.updateProjectionMatrix();

  // Accumulate N jittered samples (attachment 1, the screen, from the unjittered sample only).
  renderer.setRenderTarget(t.acc);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);
  const N = Math.max(1, job.samples | 0);
  for (let k = 0; k < N; k++) {
    const jx = k === 0 ? 0 : halton(k, 2) - 0.5;
    const jy = k === 0 ? 0 : halton(k, 3) - 0.5;
    cam.setViewOffset(W, H, jx, jy, W, H);
    renderer.setRenderTarget(t.ms);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(scene, cam);
    accumMat.uniforms.t0.value = t.ms.textures[0];
    accumMat.uniforms.t1.value = t.ms.textures[1];
    accumMat.uniforms.w0.value = 1 / N;
    accumMat.uniforms.w1.value = k === 0 ? 1 : 0;
    quad.material = accumMat;
    renderer.setRenderTarget(t.acc);
    renderer.render(quadScene, quadCam);
  }
  cam.clearViewOffset();
  outputMat.uniforms.t0.value = t.acc.textures[0];
  outputMat.uniforms.t1.value = t.acc.textures[1];
  quad.material = outputMat;
  renderer.setRenderTarget(null);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(quadScene, quadCam);
  holder.remove(group);

  // Composite over the background.
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const ctx = out.getContext('2d');
  ctx.fillStyle = job.bg; ctx.fillRect(0, 0, W, H);
  ctx.drawImage(canvas, 0, 0);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '600 15px -apple-system, system-ui, sans-serif';
  if (job.label) ctx.fillText(job.label, 14, H - 16);
  return out.toDataURL('image/png');
};

window.loadScreen = function (url) {
  return new Promise((res, rej) => {
    if (!url) return res(false);
    const img = new Image();
    img.onload = () => { screenImage = img; screenCache.clear(); res(true); };
    img.onerror = () => rej(new Error('cannot load ' + url));
    img.src = url;
  });
};

/** A contact sheet: rows of stills (data URLs) at a scale. */
window.makeSheet = async function (rows, scale) {
  const imgs = await Promise.all(rows.map((row) => Promise.all(row.map((u) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = u; })))));
  const w = imgs[0][0].width * scale, h = imgs[0][0].height * scale;
  const cols = Math.max(...imgs.map((r) => r.length));
  const c = document.createElement('canvas');
  c.width = Math.round(w * cols); c.height = Math.round(h * imgs.length);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  imgs.forEach((row, y) => row.forEach((img, x) => ctx.drawImage(img, x * w, y * h, w, h)));
  return c.toDataURL('image/png');
};

window.listFinishes = (id) => (getDevice(id) || { finishes: [] }).finishes;
window.gpu = () => {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
};
window.__ready = true;
`;

const MAIN = String.raw`
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const cfg = JSON.parse(fs.readFileSync(process.env.P3D_CONFIG, 'utf8'));
app.setPath('userData', path.join(cfg.build, 'profile'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: !!cfg.open, width: cfg.size[0], height: cfg.size[1], webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (e) => { const m = e.message || ''; if (/error/i.test(m)) process.stderr.write('[page] ' + m + '\n'); });
  await win.loadFile(cfg.html);
  const js = (code) => win.webContents.executeJavaScript(code);
  try {
    await js('window.loadScreen(' + JSON.stringify(cfg.screenUrl) + ')');
    const gpu = await js('window.gpu()');
    const results = [];
    const sheets = new Map();
    for (const job of cfg.jobs) {
      const url = await js('window.renderStill(' + JSON.stringify(job) + ')');
      const file = path.join(cfg.out, job.file);
      fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
      results.push({ file, model: job.model, finish: job.finish, angle: job.angle });
      const rows = sheets.get(job.model) || new Map();
      const row = rows.get(job.finish) || [];
      row.push(url);
      rows.set(job.finish, row);
      sheets.set(job.model, rows);
    }
    for (const [model, rows] of sheets) {
      const url = await js('window.makeSheet(' + JSON.stringify([...rows.values()]) + ', ' + cfg.sheetScale + ')');
      const file = path.join(cfg.out, 'sheet-' + model + '.png');
      fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
      results.push({ file, model, sheet: true });
    }
    fs.writeFileSync(path.join(cfg.build, 'result.json'), JSON.stringify({ ok: true, gpu, results }));
  } catch (err) {
    fs.writeFileSync(path.join(cfg.build, 'result.json'), JSON.stringify({ ok: false, error: String(err && err.stack || err) }));
  }
  app.quit();
});
`;

/** "black, silver, orange": the darkest, the lightest and the most saturated finish of a model. */
function autoFinishes(finishes) {
  const lin = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  };
  const lum = (h) => {
    const [r, g, b] = lin(h).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const sat = (h) => {
    const c = lin(h);
    return Math.max(...c) - Math.min(...c);
  };
  const by = (f) => [...finishes].sort((a, b) => f(a.hex) - f(b.hex));
  const out = [by(lum)[0], by(lum).at(-1), by(sat).at(-1)];
  return [...new Map(out.map((f) => [f.id, f])).values()];
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const build = join(o.out, '.build');
  mkdirSync(build, { recursive: true });

  // Bundle the page.
  const esbuild = await import(pathToFileURL(join(root, 'node_modules', 'esbuild', 'lib', 'main.js')).href);
  writeFileSync(join(build, 'entry.ts'), ENTRY);
  await esbuild.build({
    entryPoints: [join(build, 'entry.ts')],
    bundle: true,
    format: 'iife',
    outfile: join(build, 'page.js'),
    alias: { '@src': join(root, 'src') },
    nodePaths: [join(root, 'node_modules')],
    logLevel: 'error',
    target: 'chrome130',
  });
  writeFileSync(join(build, 'index.html'), '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#111}canvas{display:block}</style><body><script src="page.js"></script></body>');

  // Finish names come from devices.ts (read through the bundle is overkill; parse the source table).
  const { DEVICES } = await loadDevices(build, esbuild);
  const jobs = [];
  for (const id of o.models) {
    const d = DEVICES.find((x) => x.id === id);
    if (!d) throw new Error(`unknown model ${id}`);
    const fins = o.finishes === 'all' ? d.finishes : o.finishes === 'auto' ? autoFinishes(d.finishes) : d.finishes.filter((f) => o.finishes.split(',').includes(f.id));
    for (const f of fins) {
      for (const angle of o.angles) {
        jobs.push({
          model: id, finish: f.id, angle, size: o.size, bg: o.bg, preset: o.preset, azimuth: o.azimuth, glass: o.glass,
          intensity: o.intensity, samples: o.samples, label: `${d.name} · ${f.name} · ${angle}`,
          file: `${id}__${f.id}__${angle}.png`,
        });
      }
    }
  }
  const cfg = {
    build, out: o.out, html: join(build, 'index.html'), size: o.size, open: o.open, jobs,
    screenUrl: o.screen ? pathToFileURL(o.screen).href : null,
    sheetScale: o.sheetScale,
  };
  writeFileSync(join(build, 'config.json'), JSON.stringify(cfg));
  writeFileSync(join(build, 'main.cjs'), MAIN);
  const electron = join(root, 'node_modules', '.bin', 'electron');
  if (!existsSync(electron)) throw new Error(`no electron at ${electron}; run npm install in ${root}`);
  const child = spawn(electron, [join(build, 'main.cjs')], { env: { ...process.env, P3D_CONFIG: join(build, 'config.json'), ELECTRON_ENABLE_LOGGING: '' }, stdio: ['ignore', 'inherit', 'inherit'] });
  const code = await new Promise((res) => child.on('exit', res));
  const resultFile = join(build, 'result.json');
  if (!existsSync(resultFile)) throw new Error(`electron exited ${code} without a result`);
  const result = JSON.parse(readFileSync(resultFile, 'utf8'));
  if (!result.ok) throw new Error(result.error);
  writeIndex(o, result);
  process.stdout.write(JSON.stringify({ ok: true, out: o.out, index: join(o.out, 'index.html'), gpu: result.gpu, stills: result.results.filter((x) => !x.sheet).length, sheets: result.results.filter((x) => x.sheet).map((x) => x.file) }) + '\n');
}

/** DEVICES, bundled for node (devices.ts is pure). */
async function loadDevices(build, esbuild) {
  const file = join(build, 'devices.mjs');
  await esbuild.build({ entryPoints: [join(root, 'src', 'shared', 'devices.ts')], bundle: true, format: 'esm', outfile: file, logLevel: 'error', platform: 'node' });
  return import(pathToFileURL(file).href + `?t=${Date.now()}`);
}

function writeIndex(o, result) {
  const byModel = new Map();
  for (const r of result.results.filter((x) => !x.sheet)) {
    const list = byModel.get(r.model) ?? [];
    list.push(r);
    byModel.set(r.model, list);
  }
  const rel = (f) => f.slice(o.out.length + 1);
  const sections = [...byModel].map(([model, list]) => {
    const rows = new Map();
    for (const r of list) {
      const row = rows.get(r.finish) ?? [];
      row.push(r);
      rows.set(r.finish, row);
    }
    return `<h2>${model}</h2>` + [...rows].map(([fin, row]) => `<div class="row"><span>${fin}</span>${row.map((r) => `<img src="${rel(r.file)}" title="${r.angle}">`).join('')}</div>`).join('');
  });
  const ref = o.ref ? `<h2>reference</h2><div class="row"><img src="${pathToFileURL(o.ref).href}" style="height:300px"></div>` : '';
  writeFileSync(
    join(o.out, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>3D phone turntable</title><style>body{background:#161618;color:#ddd;font:14px -apple-system,system-ui;margin:24px}img{height:300px;margin:0 6px 6px 0;border-radius:6px}.row{display:flex;align-items:center}.row span{width:110px}</style><p>GPU: ${result.gpu}</p>${ref}${sections.join('')}`,
  );
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(err?.message ?? err) }) + '\n');
  process.exit(1);
});
