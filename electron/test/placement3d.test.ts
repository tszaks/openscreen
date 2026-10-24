import { beforeAll, describe, expect, it, vi } from 'vitest';
import { phone3dActive, phoneHome } from '../src/shared/phone3d/placement';
import { projectCanvasSize } from '../src/shared/mobileProject';
import type { Project } from '../src/shared/types';
import { mockCanvas } from './helpers/mockCanvas';
import { phoneProject, with3d } from './helpers/phone3dFixtures';

// A local, minimal compositor harness (spec §6.1 order). WP0 owns the shared
// one (test/helpers/compositorHarness.ts); this test can move onto it once it
// lands, with no change to what it asserts.
// 1. compositor.ts imports ./api, which reads window.openscreen at load.
vi.mock('../src/renderer/src/api', () => ({ api: { prepareBackground: async (p: string) => p } }));

type Compositor = import('../src/renderer/src/compositor').CanvasCompositor;
let CanvasCompositor: typeof import('../src/renderer/src/compositor').CanvasCompositor;

beforeAll(async () => {
  // 2. A document whose canvases draw into the logging mock; no OffscreenCanvas; images never load.
  const g = globalThis as Record<string, unknown>;
  g.document = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`unexpected element ${tag}`);
      const m = mockCanvas();
      return { width: 0, height: 0, getContext: () => m.ctx };
    },
  };
  g.Image = class {
    complete = false;
    naturalWidth = 0;
    src = '';
    onload: (() => void) | null = null;
  };
  ({ CanvasCompositor } = await import('../src/renderer/src/compositor'));
});

/** 3. Build the real compositor and render one frame with a fake video. */
function render(p: Project): Compositor {
  const canvas = projectCanvasSize(p);
  const c = new CanvasCompositor(p, canvas, []);
  const frame = { videoWidth: p.recording.sourceSize.width, videoHeight: p.recording.sourceSize.height, width: p.recording.sourceSize.width, height: p.recording.sourceSize.height } as unknown as CanvasImageSource;
  c.render(1, { frame, cursor: null, ripples: [] });
  return c;
}

const FIXTURES: [string, () => Project][] = [
  ['9:16 preset', () => phoneProject()],
  ['9:16 with title card', () => {
    const p = phoneProject();
    p.layout.titleCard = { title: 'Headline', subtitle: 'Sub' };
    return p;
  }],
  ['16:9 preset, landscape capture', () => phoneProject({ width: 2622, height: 1206, presetId: 'landscape-16x9' })],
  ['classic padded frame', () => phoneProject({ presetId: 'none' })],
  ['moved and resized (contentTransform)', () => {
    const p = phoneProject({ presetId: 'square' });
    p.style.contentTransform = { x: 0.42, y: 0.55, scale: 0.75 };
    return p;
  }],
  ['iPhone 13 mini, feed 4:5, chosen model', () => phoneProject({ width: 1080, height: 2340, presetId: 'feed-4x5', modelId: 'iphone-13-mini' })],
];

describe('phoneHome equals the compositor', () => {
  for (const [name, make] of FIXTURES) {
    it(`${name}: contentRect = phoneHome().body, 3D off and on`, () => {
      for (const p of [make(), with3d(make())]) {
        const c = render(p);
        const home = phoneHome(p, c.canvasSize)!;
        expect(home).not.toBeNull();
        expect(c.contentRect).toEqual(home.body);
        expect(c.contentBase).toEqual(home.base);
        // The compositor intersects the screen with the canvas (x + w − x): equal to 1e-9.
        const sm = c.screenMap!.screen;
        for (const k of ['x', 'y', 'w', 'h'] as const) expect(sm[k]).toBeCloseTo(home.screen[k], 9);
      }
      // 3D on does not move the content box (D20).
      expect(render(with3d(make())).contentRect).toEqual(render(make()).contentRect);
      expect(phone3dActive(with3d(make())).active).toBe(true);
    });
  }

  it('is null where the compositor draws no frame (frame off, App Store, not a phone)', () => {
    const off = phoneProject();
    off.device.frame = false;
    expect(phoneHome(off, projectCanvasSize(off))).toBeNull();
    const store = phoneProject({ presetId: 'appstore' });
    expect(phoneHome(store, projectCanvasSize(store))).toBeNull();
    expect(render(store).contentRect).toBeNull();
  });
});
