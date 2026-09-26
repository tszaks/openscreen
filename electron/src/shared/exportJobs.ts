// Multi-format export planning: which presets to offer for a recording, which
// of the chosen presets can share one rendered pass of composited frames, what
// each output file is called, and the plain-language warnings shown before
// exporting. No Electron or DOM here, so all of it is unit-tested.

import { detectDevice } from './devices';
import { PRESETS, appStorePresetFor, getPreset, validateExport, type ExportPreset, type ExportWarning, type PresetId } from './exportPresets';
import type { Project, Size } from './types';

// ---------------------------------------------------------------------------
// Which presets to offer

/** Formats offered in the Export panel for a recording of this size: the App
 *  Store size matching its orientation, the iPad one for iPad captures, then
 *  the social and web shapes. */
export function presetChoices(source: Size): ExportPreset[] {
  const landscape = source.width > source.height;
  const match = detectDevice(source.width, source.height);
  const isIpad = match.device.family === 'ipad' && match.confidence >= 0.8;
  const ids: PresetId[] = ['social-9x16', 'square', 'feed-4x5', 'landscape-16x9', 'landing-loop'];
  return [
    appStorePresetFor('iphone', landscape),
    ...(isIpad ? [appStorePresetFor('ipad', landscape)] : []),
    ...ids.map(getPreset),
  ];
}

/** Short names used in file names and task rows. */
const SHORT_NAMES: Record<PresetId, string> = {
  'appstore-iphone': 'App Store',
  'appstore-iphone-landscape': 'App Store landscape',
  'appstore-ipad': 'App Store iPad',
  'appstore-ipad-landscape': 'App Store iPad landscape',
  'social-9x16': '9x16 Social',
  'shorts-hq': 'Shorts HQ',
  square: 'Square',
  'feed-4x5': '4x5 Feed',
  'landscape-16x9': '16x9',
  'landing-loop': 'Landing loop',
};

export const shortName = (id: PresetId) => SHORT_NAMES[id];

/** Characters Finder or the shell choke on, replaced so every name is a valid file name. */
const safeName = (s: string) => s.replace(/[/:\\\0]/g, '-').replace(/^\.+/, '').trim() || 'OpenScreen';

/** Output path without an extension: "<folder>/<project> – App Store". */
export function outputBase(folder: string, projectName: string, preset: ExportPreset): string {
  return `${folder.replace(/\/+$/, '')}/${safeName(projectName)} – ${shortName(preset.id)}`;
}

/** Every file a preset writes, for the task row and Show in Finder. */
export function outputFiles(base: string, preset: ExportPreset): string[] {
  return [...preset.containers.map((c) => `${base}.${c}`), ...(preset.poster ? [`${base}-poster.jpg`] : [])];
}

// ---------------------------------------------------------------------------
// The project's own layout preset (the md-editor branch adds `layout.presetId`)

type LayoutFields = { layout?: { presetId?: unknown } & Record<string, unknown> };

/**
 * The layout preset chosen in the editor, or null for 'none' and unknown ids.
 * 'appstore' means the App Store size for the recording's device and
 * orientation. Mirrors md-editor's layoutPreset() in shared/mobileProject.ts;
 * switch to that once both branches are merged.
 */
export function layoutPresetOf(proj: Project): ExportPreset | null {
  const id = (proj as Project & LayoutFields).layout?.presetId;
  if (id === 'appstore') {
    const { width, height } = proj.recording.sourceSize;
    const match = detectDevice(width, height);
    const family = match.device.family === 'ipad' && match.confidence >= 0.8 ? 'ipad' : 'iphone';
    return appStorePresetFor(family, width > height);
  }
  return PRESETS.find((p) => p.id === id) ?? null;
}

/**
 * The project as a preset renders it. `layout.presetId` tells the compositor
 * which layout to draw; for iOS recordings it lays out at the preset's own
 * size (projectCanvasSize), which is the size planRenders gives a pass.
 * Full-bleed presets (App Store) also drop padding, rounded corners and
 * shadow: the phone layout ignores those, but desktop recordings, which keep
 * the classic padded frame, then fill the canvas instead.
 */
export function projectForPreset(proj: Project, preset: ExportPreset): Project {
  const layout = { ...(proj as Project & LayoutFields).layout, presetId: preset.id };
  const style =
    preset.layout === 'full-bleed'
      ? { ...proj.style, deviceFrame: 'none' as const, paddingFraction: 0, cornerRadius: 0, shadowOpacity: 0, shadowRadius: 0 }
      : proj.style;
  return Object.assign({}, proj, { style, layout });
}

/** Whether the editor's zooms play in this preset. Apple prefers the native UI over zooming. */
export const presetUsesZoom = (preset: ExportPreset) => preset.defaults.autoZoom;

// ---------------------------------------------------------------------------
// Render passes

export interface RenderPass {
  /** Presets that share this pass have the same key. */
  key: string;
  /** Canvas the compositor draws at (the largest preset in the pass). */
  width: number;
  height: number;
  fps: number;
  /** The preset whose layout the pass is drawn with. */
  layoutPreset: PresetId;
  zoom: boolean;
  /** Presets transcoded from this pass, in the order they were picked. */
  presetIds: PresetId[];
}

/**
 * Presets render together when the compositor would draw the same picture:
 * same shape, layout, phone size, title card, zoom and frame rate. The pass is
 * drawn at the largest size in the group and each preset scales down from it
 * (a 9:16 1080x1920 and a 1440x2560 share one pass).
 */
export function renderKey(p: ExportPreset): string {
  const aspect = (p.width / p.height).toFixed(3);
  return [aspect, p.layout, p.phoneHeight, p.titleCard ? 'title' : 'notitle', presetUsesZoom(p) ? 'zoom' : 'nozoom', p.fps].join('|');
}

export function planRenders(presets: ExportPreset[]): RenderPass[] {
  const passes = new Map<string, RenderPass>();
  for (const p of presets) {
    const key = renderKey(p);
    const pass = passes.get(key);
    if (!pass) {
      passes.set(key, {
        key, width: p.width, height: p.height, fps: p.fps, layoutPreset: p.id, zoom: presetUsesZoom(p), presetIds: [p.id],
      });
    } else if (!pass.presetIds.includes(p.id)) {
      pass.presetIds.push(p.id);
      if (p.width > pass.width) Object.assign(pass, { width: p.width, height: p.height, layoutPreset: p.id });
    }
  }
  return [...passes.values()];
}

// ---------------------------------------------------------------------------
// Progress

/** Transcoding a frame costs roughly this fraction of rendering one. */
export const ENCODE_WEIGHT = 0.4;

/** Work units for a batch, so one overall bar covers render and encode phases. */
export function batchUnits(passes: RenderPass[], duration: number): number {
  return passes.reduce((sum, r) => {
    const frames = Math.floor(duration * r.fps);
    return sum + frames + frames * ENCODE_WEIGHT * r.presetIds.length;
  }, 0);
}

// ---------------------------------------------------------------------------
// Warnings

export interface PresetCheckInput {
  /** Output duration in seconds. */
  duration: number;
  /** Source size after the user's crop. */
  source: Size;
  /** Undefined until main has probed the file. */
  hasAudio?: boolean;
}

/** validateExport for what this export will really contain. App Store presets
 *  drop zoom and frame themselves, so those never warn. */
export function presetWarnings(preset: ExportPreset, input: PresetCheckInput): ExportWarning[] {
  return validateExport(preset, {
    duration: input.duration,
    sourceWidth: Math.round(input.source.width),
    sourceHeight: Math.round(input.source.height),
    hasAudio: input.hasAudio,
    usesAutoZoom: false,
    usesDeviceFrame: false,
  });
}

/** The recording's size after the user's crop. */
export function croppedSource(proj: Project): Size {
  const { width, height } = proj.recording.sourceSize;
  const c = proj.style.cropRect;
  return c ? { width: width * c.w, height: height * c.h } : { width, height };
}
