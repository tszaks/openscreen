// Export presets for phone demo videos: App Store previews, social, web.
//
// Sources (verified 2026-09-26, see /tmp/os-fixture/mobile-research.md):
// - App Store app previews: 15-30 s, <=30 fps, H.264 High Profile up to
//   Level 4.0 at 10-12 Mbps (or ProRes 422 HQ), stereo AAC 256 kbps at 44.1
//   or 48 kHz, 500 MB max; 886x1920 covers every modern iPhone, 1200x1600
//   every iPad. https://developer.apple.com/help/app-store-connect/reference/app-information/app-preview-specifications/
//   Apple prefers native UI over zoom: https://developer.apple.com/app-store/app-previews/
// - Vertical social: 1080x1920, keep text inside the centre 856x1094 (avoid
//   top 250, bottom 576, right 164, left 60). https://admakeai.com/blog/vertical-video-dimensions-2026
// - Landing loops: H.264 + WebM, no audio track, +faststart, CRF ~28, poster
//   frame. https://web.dev/learn/performance/video-performance

export type PresetId =
  | 'appstore-iphone'
  | 'appstore-iphone-landscape'
  | 'appstore-ipad'
  | 'appstore-ipad-landscape'
  | 'social-9x16'
  | 'shorts-hq'
  | 'square'
  | 'feed-4x5'
  | 'landscape-16x9'
  | 'landing-loop';

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type Container = 'mp4' | 'mov' | 'webm';

export interface ExportPreset {
  id: PresetId;
  label: string;
  group: 'App Store' | 'Social' | 'Web';
  width: number;
  height: number;
  /** Output frame rate (constant). */
  fps: number;
  /** Highest frame rate the destination accepts. */
  maxFps: number;
  video: {
    codec: 'h264';
    profile: 'high';
    /** H.264 level cap, when the destination enforces one. */
    level?: '4.0';
    /** Constant-ish bitrate targets (kbps). */
    bitrateKbps?: { target: number; max: number };
    /** Quality-based encoding instead of a bitrate. */
    crf?: number;
  };
  audio:
    | { mode: 'none' }
    | {
        mode: 'aac-stereo';
        bitrateKbps: number;
        sampleRate: 48000;
        /** Add a silent stereo track when the recording has no audio. */
        silentIfMissing: boolean;
        /** Normalize loudness (LUFS), for feeds that autoplay. */
        loudnessLufs?: number;
      };
  /** Output containers; the first is the primary file. */
  containers: Container[];
  /** Seconds. `min`/`max` are hard limits; `ideal` is advice. */
  duration?: { min?: number; max?: number; ideal?: [number, number] };
  maxFileMB?: number;
  /** full-bleed: the screen fills the canvas, no frame. framed: floating phone. */
  layout: 'full-bleed' | 'framed';
  /** Framed layouts: phone height as a fraction of the canvas height. */
  phoneHeight: number;
  /** Whether a title card fits this layout. */
  titleCard: boolean;
  /** Defaults for the editor when this preset is picked. */
  defaults: { autoZoom: boolean; deviceFrame: boolean; touches: boolean };
  /** Keep text inside the canvas minus these insets (px). */
  safeZone?: Insets;
  /** Also export a poster image of the first frame. */
  poster: boolean;
  /** Only dissolves and fades (App Store content rule). */
  fadesOnly: boolean;
}

const APP_STORE_VIDEO = {
  codec: 'h264',
  profile: 'high',
  level: '4.0',
  bitrateKbps: { target: 11000, max: 12000 },
} as const;
const APP_STORE_AUDIO = { mode: 'aac-stereo', bitrateKbps: 256, sampleRate: 48000, silentIfMissing: true } as const;
const SOCIAL_AUDIO = {
  mode: 'aac-stereo', bitrateKbps: 256, sampleRate: 48000, silentIfMissing: false, loudnessLufs: -14,
} as const;

const appStore = (
  id: PresetId, label: string, width: number, height: number,
): ExportPreset => ({
  id, label, group: 'App Store', width, height, fps: 30, maxFps: 30,
  video: APP_STORE_VIDEO, audio: APP_STORE_AUDIO, containers: ['mp4'],
  duration: { min: 15, max: 30 }, maxFileMB: 500,
  layout: 'full-bleed', phoneHeight: 1, titleCard: false,
  defaults: { autoZoom: false, deviceFrame: false, touches: true },
  poster: false, fadesOnly: true,
});

export const PRESETS: ExportPreset[] = [
  appStore('appstore-iphone', 'App Store iPhone', 886, 1920),
  appStore('appstore-iphone-landscape', 'App Store iPhone (landscape)', 1920, 886),
  appStore('appstore-ipad', 'App Store iPad', 1200, 1600),
  appStore('appstore-ipad-landscape', 'App Store iPad (landscape)', 1600, 1200),
  {
    id: 'social-9x16', label: 'Reels / TikTok / Shorts 9:16', group: 'Social',
    width: 1080, height: 1920, fps: 30, maxFps: 60,
    video: { codec: 'h264', profile: 'high', bitrateKbps: { target: 10000, max: 12000 } },
    audio: SOCIAL_AUDIO, containers: ['mp4'],
    duration: { ideal: [15, 30] },
    layout: 'framed', phoneHeight: 0.7, titleCard: true,
    defaults: { autoZoom: true, deviceFrame: true, touches: true },
    safeZone: { top: 250, right: 164, bottom: 576, left: 60 },
    poster: false, fadesOnly: false,
  },
  {
    id: 'shorts-hq', label: 'YouTube Shorts HQ 1440x2560', group: 'Social',
    width: 1440, height: 2560, fps: 30, maxFps: 60,
    video: { codec: 'h264', profile: 'high', bitrateKbps: { target: 17000, max: 20000 } },
    audio: SOCIAL_AUDIO, containers: ['mp4'],
    duration: { max: 180, ideal: [15, 30] },
    layout: 'framed', phoneHeight: 0.7, titleCard: true,
    defaults: { autoZoom: true, deviceFrame: true, touches: true },
    safeZone: { top: 333, right: 219, bottom: 768, left: 80 },
    poster: false, fadesOnly: false,
  },
  {
    id: 'square', label: 'Square 1:1', group: 'Social',
    width: 1080, height: 1080, fps: 30, maxFps: 60,
    video: { codec: 'h264', profile: 'high', bitrateKbps: { target: 9000, max: 10000 } },
    audio: SOCIAL_AUDIO, containers: ['mp4'],
    layout: 'framed', phoneHeight: 0.84, titleCard: true,
    defaults: { autoZoom: true, deviceFrame: true, touches: true },
    poster: false, fadesOnly: false,
  },
  {
    id: 'feed-4x5', label: 'Feed 4:5', group: 'Social',
    width: 1080, height: 1350, fps: 30, maxFps: 60,
    video: { codec: 'h264', profile: 'high', bitrateKbps: { target: 9000, max: 10000 } },
    audio: SOCIAL_AUDIO, containers: ['mp4'],
    layout: 'framed', phoneHeight: 0.8, titleCard: true,
    defaults: { autoZoom: true, deviceFrame: true, touches: true },
    poster: false, fadesOnly: false,
  },
  {
    id: 'landscape-16x9', label: 'Landscape 16:9', group: 'Web',
    width: 1920, height: 1080, fps: 30, maxFps: 60,
    video: { codec: 'h264', profile: 'high', bitrateKbps: { target: 14000, max: 20000 } },
    audio: { ...SOCIAL_AUDIO, loudnessLufs: undefined }, containers: ['mp4'],
    layout: 'framed', phoneHeight: 0.86, titleCard: true,
    defaults: { autoZoom: true, deviceFrame: true, touches: true },
    poster: false, fadesOnly: false,
  },
  {
    id: 'landing-loop', label: 'Landing page loop', group: 'Web',
    width: 720, height: 1280, fps: 30, maxFps: 30,
    video: { codec: 'h264', profile: 'high', crf: 28 },
    audio: { mode: 'none' }, containers: ['mp4', 'webm'],
    duration: { ideal: [6, 20] }, maxFileMB: 5,
    layout: 'framed', phoneHeight: 0.9, titleCard: false,
    defaults: { autoZoom: true, deviceFrame: true, touches: true },
    poster: true, fadesOnly: false,
  },
];

export function getPreset(id: PresetId): ExportPreset {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown export preset: ${id}`);
  return p;
}

/** Portrait-or-landscape App Store preset matching a capture's orientation. */
export function appStorePresetFor(family: 'iphone' | 'ipad', landscape: boolean): ExportPreset {
  const id = `appstore-${family}${landscape ? '-landscape' : ''}` as PresetId;
  return getPreset(id);
}

/** Canvas rect inside the safe zone (whole canvas when there is none). */
export function safeRect(p: ExportPreset): { x: number; y: number; w: number; h: number } {
  const s = p.safeZone ?? { top: 0, right: 0, bottom: 0, left: 0 };
  return { x: s.left, y: s.top, w: p.width - s.left - s.right, h: p.height - s.top - s.bottom };
}

// ---------------------------------------------------------------------------
// Validation

export interface ExportCheckInput {
  /** Output duration in seconds. */
  duration: number;
  /** Source frame rate (VFR captures: the peak). */
  sourceFps?: number;
  /** Source size, to warn about upscaling. */
  sourceWidth?: number;
  sourceHeight?: number;
  hasAudio?: boolean;
  /** Final file size, when checking after export. */
  fileSizeMB?: number;
  usesAutoZoom?: boolean;
  usesDeviceFrame?: boolean;
  /** Title card rect in canvas px, to check against the safe zone. */
  titleRect?: { x: number; y: number; w: number; h: number };
  /** Transition styles used between clips. */
  transitions?: Array<'cut' | 'fade' | 'dissolve' | 'slide' | 'zoom' | 'other'>;
}

export interface ExportWarning {
  /** error = the destination will reject it; warning = likely a problem; info = FYI. */
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}

const secs = (s: number) => `${Math.round(s * 10) / 10} s`;

export function validateExport(p: ExportPreset, input: ExportCheckInput): ExportWarning[] {
  const out: ExportWarning[] = [];
  const d = input.duration;
  const isAppStore = p.group === 'App Store';
  const { min, max, ideal } = p.duration ?? {};

  if (min !== undefined && max !== undefined && (d < min || d > max)) {
    const what = isAppStore ? 'App Store previews' : `${p.label} videos`;
    out.push({
      level: 'error',
      code: d < min ? 'too-short' : 'too-long',
      message: `${what} must be ${min}–${max} s; yours is ${secs(d)}.`,
    });
  } else if (max !== undefined && d > max) {
    out.push({ level: 'error', code: 'too-long', message: `${p.label} allows up to ${max} s; yours is ${secs(d)}.` });
  } else if (min !== undefined && d < min) {
    out.push({ level: 'error', code: 'too-short', message: `${p.label} needs at least ${min} s; yours is ${secs(d)}.` });
  }
  if (ideal && (d < ideal[0] || d > ideal[1]) && !out.some((w) => w.level === 'error')) {
    out.push({
      level: 'info',
      code: 'outside-ideal',
      message:
        p.id === 'landing-loop'
          ? `Landing loops work best at ${ideal[0]}–${ideal[1]} s; yours is ${secs(d)}.`
          : `${ideal[0]}–${ideal[1]} s is the sweet spot for ${p.label}; yours is ${secs(d)}.`,
    });
  }

  if (input.sourceFps !== undefined && input.sourceFps > p.maxFps + 0.5) {
    out.push({
      level: 'info',
      code: 'fps-resample',
      message: `Your recording runs up to ${Math.round(input.sourceFps)} fps; it will be exported at a constant ${p.fps} fps.`,
    });
  }

  if (input.sourceWidth && input.sourceHeight && p.layout === 'full-bleed') {
    const need = Math.max(p.width / input.sourceWidth, p.height / input.sourceHeight);
    if (need > 1.05) {
      out.push({
        level: 'warning',
        code: 'upscale',
        message: `The recording (${input.sourceWidth}x${input.sourceHeight}) is smaller than ${p.width}x${p.height}; it will be upscaled and look soft.`,
      });
    }
    const srcAspect = input.sourceWidth / input.sourceHeight;
    const outAspect = p.width / p.height;
    if (Math.abs(srcAspect - outAspect) / outAspect > 0.03) {
      out.push({
        level: 'info',
        code: 'crop',
        message: `The recording's shape differs from ${p.width}x${p.height}; the edges will be cropped to fill the frame.`,
      });
    }
  }

  if (p.audio.mode === 'aac-stereo' && input.hasAudio === false) {
    out.push(
      p.audio.silentIfMissing
        ? { level: 'info', code: 'silent-audio', message: 'No audio in the recording, so a silent stereo track will be added (App Store Connect expects one).' }
        : { level: 'info', code: 'no-audio', message: 'No audio: feeds autoplay muted anyway, so on-screen text carries the message.' },
    );
  }

  if (p.maxFileMB !== undefined && input.fileSizeMB !== undefined && input.fileSizeMB > p.maxFileMB) {
    out.push({
      level: p.id === 'landing-loop' ? 'warning' : 'error',
      code: 'file-too-big',
      message:
        p.id === 'landing-loop'
          ? `Landing loops should stay under ${p.maxFileMB} MB to load fast; yours is ${input.fileSizeMB.toFixed(1)} MB. Shorten it or raise the CRF.`
          : `${p.label} files must be under ${p.maxFileMB} MB; yours is ${input.fileSizeMB.toFixed(1)} MB.`,
    });
  }

  if (isAppStore) {
    if (input.usesAutoZoom) {
      out.push({
        level: 'warning',
        code: 'appstore-zoom',
        message: 'Apple recommends showing the native UI rather than zooming in; consider turning auto-zoom off for App Store previews.',
      });
    }
    if (input.usesDeviceFrame) {
      out.push({
        level: 'warning',
        code: 'appstore-frame',
        message: 'A device frame in an App Store preview can be rejected; a full-screen recording is the safe choice.',
      });
    }
  }

  if (p.fadesOnly && input.transitions?.some((t) => t !== 'cut' && t !== 'fade' && t !== 'dissolve')) {
    out.push({
      level: 'warning',
      code: 'transitions',
      message: 'App Store previews should use simple transitions like dissolves and fades.',
    });
  }

  if (input.titleRect && p.safeZone) {
    const s = safeRect(p);
    const r = input.titleRect;
    if (r.x < s.x || r.y < s.y || r.x + r.w > s.x + s.w || r.y + r.h > s.y + s.h) {
      out.push({
        level: 'warning',
        code: 'unsafe-title',
        message: 'The title extends outside the safe zone; app buttons and captions may cover it.',
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// ffmpeg

export interface FfmpegExportOptions {
  input: string;
  output: string;
  /** Does the input carry an audio stream? */
  hasAudio: boolean;
  /** Which of the preset's containers to write. Defaults to the primary one. */
  container?: Container;
  /** x264 speed/quality tradeoff. */
  x264Preset?: 'medium' | 'slow' | 'veryslow';
}

/**
 * Encoder arguments for one output of a preset. Scales and pads to the exact
 * size, resamples variable-frame-rate captures to constant fps, tags
 * Rec. 709 colour (the iPhone capture is sRGB/709) and places the moov atom
 * up front.
 */
export function ffmpegArgsFor(p: ExportPreset, o: FfmpegExportOptions): string[] {
  const container = o.container ?? p.containers[0];
  if (!p.containers.includes(container)) throw new Error(`${p.label} does not export ${container}`);
  const { width: W, height: H, fps } = p;
  const args = ['-hide_banner', '-y', '-i', o.input];

  const wantsAudio = p.audio.mode === 'aac-stereo' && container !== 'webm';
  const silent = wantsAudio && !o.hasAudio && p.audio.mode === 'aac-stereo' && p.audio.silentIfMissing;
  if (silent) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');

  args.push('-map', '0:v:0');
  if (wantsAudio && o.hasAudio) args.push('-map', '0:a:0');
  else if (silent) args.push('-map', '1:a:0');

  args.push(
    '-vf',
    [
      `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos`,
      `crop=${W}:${H}`,
      'setsar=1',
      `fps=${fps}`,
    ].join(','),
    '-fps_mode', 'cfr',
    '-r', String(fps),
  );

  if (container === 'webm') {
    args.push(
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p',
      '-crf', String(Math.round((p.video.crf ?? 28) + 6)), '-b:v', '0',
      '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2',
    );
  } else {
    args.push(
      '-c:v', 'libx264', '-profile:v', p.video.profile, '-pix_fmt', 'yuv420p',
      '-preset', o.x264Preset ?? 'slow',
    );
    if (p.video.level) args.push('-level:v', p.video.level);
    if (p.video.bitrateKbps) {
      const { target, max } = p.video.bitrateKbps;
      if (p.id.startsWith('appstore')) {
        // App Store Connect's spec is 10-12 Mbps. Single-pass VBR drops to
        // ~1 Mbps on mostly static app footage, so hold a constant rate
        // (HRD CBR pads with filler) to stay inside the published range.
        args.push(
          '-b:v', `${target}k`, '-minrate', `${target}k`, '-maxrate', `${target}k`,
          '-bufsize', `${target}k`, '-x264-params', 'nal-hrd=cbr:force-cfr=1',
        );
      } else {
        args.push('-b:v', `${target}k`, '-maxrate', `${max}k`, '-bufsize', `${max * 2}k`);
      }
    } else {
      args.push('-crf', String(p.video.crf ?? 23));
    }
    // Keyframe every 2 s: scrubbing and platform re-encodes both like it.
    args.push('-g', String(fps * 2));
  }
  args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');

  if (wantsAudio && (o.hasAudio || silent) && p.audio.mode === 'aac-stereo') {
    if (o.hasAudio && p.audio.loudnessLufs !== undefined) {
      args.push('-af', `loudnorm=I=${p.audio.loudnessLufs}:TP=-1.5:LRA=11`);
    }
    args.push('-c:a', 'aac', '-b:a', `${p.audio.bitrateKbps}k`, '-ar', String(p.audio.sampleRate), '-ac', '2');
    if (silent) args.push('-shortest');
  } else {
    args.push('-an');
  }

  if (container !== 'webm') args.push('-movflags', '+faststart');
  args.push(o.output);
  return args;
}

/** Poster frame (first frame) as JPEG. */
export function posterArgsFor(p: ExportPreset, input: string, output: string): string[] {
  return [
    '-hide_banner', '-y', '-i', input,
    '-vf', `scale=${p.width}:${p.height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${p.width}:${p.height}`,
    '-frames:v', '1', '-q:v', '3', output,
  ];
}

export interface FfmpegJob {
  kind: 'video' | 'poster';
  output: string;
  args: string[];
}

/** Every file a preset produces: one video per container, plus a poster. */
export function ffmpegJobsFor(p: ExportPreset, input: string, outBase: string, hasAudio: boolean): FfmpegJob[] {
  const jobs: FfmpegJob[] = p.containers.map((container) => {
    const output = `${outBase}.${container}`;
    return { kind: 'video', output, args: ffmpegArgsFor(p, { input, output, hasAudio, container }) };
  });
  if (p.poster) {
    const output = `${outBase}-poster.jpg`;
    jobs.push({ kind: 'poster', output, args: posterArgsFor(p, input, output) });
  }
  return jobs;
}
