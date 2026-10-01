import { describe, expect, it } from 'vitest';
import {
  CORNER_MAX,
  dualOutcome,
  phoneAspect,
  phoneDevice,
  phoneLayerOn,
  phoneLayerRects,
  phoneOffsetSeconds,
  phoneRecordingFields,
  phoneTimeAt,
  phoneTimeForSource,
  type PhoneSide,
  type Rect,
} from '../src/shared/phoneLayer';
import { Timeline } from '../src/shared/timeline';
import { defaultPhoneOverlay, defaultProject, normalizeProject, resetProject, type PhoneOverlay, type Project, type RecordingRef } from '../src/shared/types';
import { applyOp, OpError, validateProject } from '../src/shared/agentOps';
import { buildExportArgs, phoneChain } from '../src/shared/exportArgs';

const PHONE = { width: 1206, height: 2622 };
const dual = (extra: Partial<RecordingRef> = {}): Project =>
  defaultProject({
    screenVideoFile: 'screen.webm',
    sourceKind: 'display',
    sourceSize: { width: 1920, height: 1080 },
    duration: 10,
    phoneVideoFile: 'phone.mov',
    phoneOffset: -0.5,
    phoneSize: PHONE,
    phoneDuration: 11,
    ...extra,
  });
const macOnly = (): Project =>
  defaultProject({ screenVideoFile: 'screen.webm', sourceKind: 'display', sourceSize: { width: 1920, height: 1080 }, duration: 10 });

describe('phone layer time', () => {
  it('maps source time through the offset, holding the first and last frames outside the phone take', () => {
    // Phone started 0.5 s before the Mac: Mac 0 s is phone 0.5 s.
    expect(phoneTimeForSource(0, -0.5, 11)).toBeCloseTo(0.5);
    expect(phoneTimeForSource(4, -0.5, 11)).toBeCloseTo(4.5);
    // Phone started 1.25 s after the Mac: before that it holds its first frame.
    expect(phoneTimeForSource(1, 1.25, 11)).toBe(0);
    expect(phoneTimeForSource(3, 1.25, 11)).toBeCloseTo(1.75);
    // Past the end of the phone movie it holds the last frame.
    expect(phoneTimeForSource(20, 0, 11)).toBe(11);
    // A missing offset or length is no offset and no end.
    expect(phoneTimeForSource(3, NaN)).toBe(3);
  });

  it('follows cuts and speed changes on the output timeline', () => {
    // Keep 0-2 s at 1x, cut 2-5 s, then 5-9 s at 2x.
    const tl = new Timeline(10, [
      { id: 'a', sourceStart: 0, sourceEnd: 2, speed: 1 },
      { id: 'b', sourceStart: 5, sourceEnd: 9, speed: 2 },
    ]);
    const rec = { phoneOffset: -0.5, phoneDuration: 11 };
    expect(phoneTimeAt(1, tl, rec)).toBeCloseTo(1.5);
    // Output 2 s is source 5 s (the cut is skipped): phone 5.5 s.
    expect(phoneTimeAt(2, tl, rec)).toBeCloseTo(5.5);
    // Output 3 s is 1 s into the 2x clip: source 7 s, phone 7.5 s.
    expect(phoneTimeAt(3, tl, rec)).toBeCloseTo(7.5);
    expect(phoneTimeAt(tl.outputDuration + 0.1, tl, rec)).toBeNull();
    // A reordered timeline: the phone follows the footage, not the clock.
    const swapped = new Timeline(10, [tl.clips[1], tl.clips[0]]);
    expect(phoneTimeAt(0.5, swapped, rec)).toBeCloseTo(6.5);
    expect(phoneTimeAt(2.5, swapped, rec)).toBeCloseTo(1);
  });

  it('measures the offset between the two starts in seconds', () => {
    expect(phoneOffsetSeconds(10_000, 9_250)).toBeCloseTo(-0.75);
    expect(phoneOffsetSeconds(10_000, 10_040)).toBeCloseTo(0.04);
    // An unknown start never invents an offset.
    expect(phoneOffsetSeconds(0, 9_000)).toBe(0);
  });
});

describe('phone layer layout', () => {
  const pad = (W: number, H: number): Rect => {
    const p = Math.min(W, H) * 0.08;
    return { x: p, y: p, w: W - p * 2, h: H - p * 2 };
  };
  const inside = (r: Rect, o: Rect) => r.x >= o.x - 1e-6 && r.y >= o.y - 1e-6 && r.x + r.w <= o.x + o.w + 1e-6 && r.y + r.h <= o.y + o.h + 1e-6;
  const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;
  const macAspect = 16 / 10;
  const framed = phoneAspect(PHONE, { frame: true });
  const canvases = [
    { name: '16:9', W: 1920, H: 1080 },
    { name: '9:16', W: 1080, H: 1920 },
    { name: '1:1', W: 1080, H: 1080 },
  ];
  const overlay = (layout: PhoneOverlay['layout'], corner: PhoneOverlay['corner'] = 'bottomRight', size = 0.9) => ({ layout, corner, size });

  it('detects the phone model from the video size and places its framed body', () => {
    const d = phoneDevice(PHONE, {});
    expect(d.device.family).toBe('iphone');
    expect(d.orientation).toBe('portrait');
    expect(framed).toBeCloseTo(d.device.bodyMm.width / d.device.bodyMm.height, 6);
    expect(phoneAspect(PHONE, { frame: false })).toBeCloseTo(1206 / 2622, 6);
    // A landscape phone is wider than tall.
    expect(phoneAspect({ width: 2622, height: 1206 }, { frame: true })).toBeGreaterThan(1);
  });

  for (const { name, W, H } of canvases) {
    const content = pad(W, H);
    for (const layout of ['side-by-side-right', 'side-by-side-left'] as const) {
      it(`${layout} on ${name}: both inside the canvas, side by side, never overlapping, aspects kept`, () => {
        const r = phoneLayerRects(content, macAspect, framed, overlay(layout));
        expect(inside(r.mac, content)).toBe(true);
        expect(inside(r.phone, content)).toBe(true);
        expect(overlaps(r.mac, r.phone)).toBe(false);
        expect(r.mac.w / r.mac.h).toBeCloseTo(macAspect, 6);
        expect(r.phone.w / r.phone.h).toBeCloseTo(framed, 6);
        const right = layout === 'side-by-side-right';
        if (H > W * 1.2) {
          // Portrait: a column, phone below (right) or above (left).
          expect(r.arrangement).toBe('column');
          expect(right ? r.phone.y > r.mac.y + r.mac.h - 1e-6 : r.phone.y + r.phone.h < r.mac.y + 1e-6).toBe(true);
          expect(r.mac.w).toBeCloseTo(content.w, 6);
        } else {
          expect(r.arrangement).toBe('row');
          expect(right ? r.phone.x > r.mac.x + r.mac.w - 1e-6 : r.phone.x + r.phone.w < r.mac.x + 1e-6).toBe(true);
          // The pair is centred across the canvas.
          const left = Math.min(r.mac.x, r.phone.x);
          const end = Math.max(r.mac.x + r.mac.w, r.phone.x + r.phone.w);
          expect(left - content.x).toBeCloseTo(content.x + content.w - end, 6);
        }
        // Each side gets a real share of the canvas.
        expect(r.mac.w * r.mac.h).toBeGreaterThan(W * H * 0.1);
        expect(r.phone.h).toBeGreaterThan(H * 0.25);
      });
    }

    for (const corner of ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as const) {
      it(`corner ${corner} on ${name}: over that corner of the full-size Mac screen`, () => {
        const r = phoneLayerRects(content, macAspect, framed, overlay('corner', corner));
        expect(r.arrangement).toBe('corner');
        // The Mac screen keeps its classic place and size.
        const full = phoneLayerRects(content, macAspect, framed, overlay('corner', corner, 0.3)).mac;
        expect(r.mac).toEqual(full);
        expect(Math.min(r.mac.w, content.w)).toBeCloseTo(r.mac.w, 6);
        expect(inside(r.phone, r.mac)).toBe(true);
        expect(r.phone.h).toBeCloseTo(r.mac.h * CORNER_MAX * 0.9, 6);
        const cx = r.phone.x + r.phone.w / 2;
        const cy = r.phone.y + r.phone.h / 2;
        expect(cx > r.mac.x + r.mac.w / 2).toBe(/Right/.test(corner));
        expect(cy > r.mac.y + r.mac.h / 2).toBe(/bottom/.test(corner));
      });
    }
  }

  it('size scales the phone; a landscape phone in a corner keeps to half the screen width', () => {
    const content = pad(1920, 1080);
    const big = phoneLayerRects(content, macAspect, framed, overlay('side-by-side-right', 'bottomRight', 1));
    const small = phoneLayerRects(content, macAspect, framed, overlay('side-by-side-right', 'bottomRight', 0.5));
    expect(small.phone.h).toBeCloseTo(big.phone.h / 2, 6);
    expect(small.mac.w).toBeGreaterThan(big.mac.w);
    // Out-of-range sizes are clamped.
    expect(phoneLayerRects(content, macAspect, framed, overlay('side-by-side-right', 'bottomRight', 5)).phone).toEqual(big.phone);
    const wide = phoneLayerRects(content, macAspect, 2.2, overlay('corner', 'topLeft', 1));
    expect(wide.phone.w).toBeLessThanOrEqual(wide.mac.w * 0.5 + 1e-6);
  });
});

describe('phone layer model', () => {
  it('is drawn only for a Mac take with a phone video, switched on', () => {
    expect(phoneLayerOn(dual())).toBe(true);
    expect(phoneLayerOn({ ...dual(), phoneOverlay: { ...dual().phoneOverlay, enabled: false } })).toBe(false);
    expect(phoneLayerOn(macOnly())).toBe(false);
    expect(macOnly().phoneOverlay.enabled).toBe(false);
  });

  it('migrates older projects: absent = no phone layer, saved values kept in range', () => {
    const old = macOnly() as Partial<Project>;
    delete old.phoneOverlay;
    const n = normalizeProject(old as Project);
    expect(n.phoneOverlay).toEqual(defaultPhoneOverlay(n.recording));
    expect(n.phoneOverlay.enabled).toBe(false);
    expect(phoneLayerOn(n)).toBe(false);

    // A take that has a phone video but no saved block gets the default, on.
    const withPhone = dual() as Partial<Project>;
    delete withPhone.phoneOverlay;
    expect(normalizeProject(withPhone as Project).phoneOverlay.enabled).toBe(true);

    // Damaged values fall back or clamp; "on" without a phone video is off.
    const bad = normalizeProject({ ...macOnly(), phoneOverlay: { enabled: true, layout: 'diagonal', corner: 'middle', size: 9, frame: 'yes', shadow: false, sound: 1 } as unknown as PhoneOverlay });
    expect(bad.phoneOverlay).toEqual({ ...defaultPhoneOverlay(bad.recording), size: 1, shadow: false });
    const kept = normalizeProject({ ...dual(), phoneOverlay: { ...dual().phoneOverlay, layout: 'corner', corner: 'topLeft', size: 0.1, sound: true, modelId: 'iphone-17-pro' } });
    expect(kept.phoneOverlay).toMatchObject({ enabled: true, layout: 'corner', corner: 'topLeft', size: 0.3, sound: true, modelId: 'iphone-17-pro' });
  });

  it('reset keeps the phone layer on with its defaults', () => {
    const edited = { ...dual(), phoneOverlay: { ...dual().phoneOverlay, enabled: false, layout: 'corner' as const, sound: true } };
    expect(resetProject(edited).phoneOverlay).toEqual(defaultPhoneOverlay(edited.recording));
    expect(resetProject(edited).phoneOverlay.enabled).toBe(true);
  });

  it('agent op sets the phone fields, refuses Mac-only takes, and validates', () => {
    const ctx = { newId: () => 'x' };
    let p = applyOp(dual(), { op: 'phone', layout: 'corner', corner: 'topLeft', size: 0.5, frame: false, sound: true, modelId: 'iphone-17-pro' }, ctx).project;
    expect(p.phoneOverlay).toMatchObject({ layout: 'corner', corner: 'topLeft', size: 0.5, frame: false, sound: true, modelId: 'iphone-17-pro' });
    p = applyOp(p, { op: 'phone', modelId: null, enabled: false }, ctx).project;
    expect(p.phoneOverlay.modelId).toBeUndefined();
    expect(p.phoneOverlay.enabled).toBe(false);
    expect(() => applyOp(macOnly(), { op: 'phone', enabled: true }, ctx)).toThrow(OpError);
    expect(validateProject({ ...dual(), phoneOverlay: { ...dual().phoneOverlay, layout: 'diagonal' as never } })).toContain(
      'phoneOverlay.layout must be side-by-side-right|side-by-side-left|corner',
    );
    expect(validateProject({ ...macOnly(), phoneOverlay: { ...macOnly().phoneOverlay, enabled: true } })).toContain(
      'phoneOverlay is enabled but the recording has no phone video',
    );
    expect(validateProject(dual())).toEqual([]);
  });
});

describe('dual takes: one side failing keeps the other', () => {
  const ok: PhoneSide = { state: 'ok', duration: 12, width: 1206, height: 2622 };

  it('both fine: the Mac project carries the phone, nothing to say', () => {
    expect(dualOutcome({ state: 'saved' }, ok)).toEqual({ open: 'mac', phoneInMac: true, notice: null });
    expect(phoneRecordingFields(ok, -0.4)).toEqual({ phoneVideoFile: 'phone.mov', phoneOffset: -0.4, phoneSize: { width: 1206, height: 2622 }, phoneDuration: 12 });
  });

  it('the phone never started: the Mac take stands alone and says why', () => {
    const o = dualOutcome({ state: 'saved' }, { state: 'startFailed', error: 'No picture from your iPhone.' });
    expect(o).toMatchObject({ open: 'mac', phoneInMac: false });
    expect(o.notice).toBe("The iPhone didn't start recording (No picture from your iPhone), so only the screen was recorded.");
    expect(phoneRecordingFields({ state: 'startFailed', error: 'x' }, 0)).toEqual({});
  });

  it('the phone failed at stop or came back empty: the Mac take is saved without it', () => {
    expect(dualOutcome({ state: 'saved' }, { state: 'failed', error: 'helper exited' })).toMatchObject({ open: 'mac', phoneInMac: false });
    expect(dualOutcome({ state: 'saved' }, { state: 'failed', error: 'helper exited' }).notice).toContain('The screen recording was saved');
    expect(dualOutcome({ state: 'saved' }, { ...ok, duration: 0 })).toMatchObject({ open: 'mac', phoneInMac: false });
  });

  it('the phone stopped early: both are kept and the hold is explained', () => {
    const o = dualOutcome({ state: 'saved' }, { ...ok, endedEarly: true });
    expect(o).toMatchObject({ open: 'mac', phoneInMac: true });
    expect(o.notice).toContain('Both recordings were saved');
    expect(dualOutcome({ state: 'saved' }, { ...ok, partial: true }).phoneInMac).toBe(true);
  });

  it('the Mac side failed: the phone opens on its own; with neither, the error', () => {
    const o = dualOutcome({ state: 'failed', error: 'disk full' }, ok);
    expect(o).toEqual({ open: 'phone', phoneInMac: false, notice: "The screen recording couldn't be saved (disk full). The iPhone recording was kept and is open." });
    expect(dualOutcome({ state: 'failed', error: 'disk full' }, { state: 'failed', error: 'x' })).toEqual({ open: 'none', phoneInMac: false, notice: "Couldn't save the recording: disk full." });
    expect(dualOutcome({ state: 'failed', error: 'disk full' }, { state: 'off' }).open).toBe('none');
  });

  it('a Mac-only take is untouched', () => {
    expect(dualOutcome({ state: 'saved' }, { state: 'off' })).toEqual({ open: 'mac', phoneInMac: false, notice: null });
  });
});

describe('export audio with the phone', () => {
  const filterOf = (argv: string[]) => argv[argv.indexOf('-filter_complex') + 1] ?? '';
  const base = { outPath: '/b/o.mp4', w: 1920, h: 1080, fps: 30, duration: 6, audioIn: '/b/screen.webm', hasAudio: true };
  const phone = { path: '/b/phone.mov', offset: -0.5 };

  it('leaves the phone out when Phone sound is off (or it has no audio)', () => {
    const off = buildExportArgs(base);
    expect(off).not.toContain('/b/phone.mov');
    expect(filterOf(off)).toBe('anullsrc=r=48000:cl=stereo:d=6.000[bed];[bed][1:a]amix=inputs=2:duration=first:normalize=0[aout]');
    expect(buildExportArgs({ ...base, phone, hasPhoneAudio: false })).toEqual(off);
  });

  it('mixes the phone, shifted onto the Mac clock, over the same bed', () => {
    const argv = buildExportArgs({ ...base, phone, hasPhoneAudio: true });
    // Inputs: frames (0), the Mac recording (1), the phone (2).
    expect(argv.join(' ')).toContain('-i /b/screen.webm -i /b/phone.mov -filter_complex');
    const f = filterOf(argv);
    // It started 0.5 s before the Mac, so its first 0.5 s is trimmed off.
    expect(f).toContain('[2:a]atrim=start=0.500,asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[phone]');
    expect(f).toMatch(/\[bed\]\[1:a\]\[phone\]amix=inputs=3:duration=first:normalize=0\[aout\]$/);
  });

  it('follows cuts and speed exactly like the program audio, after clicks and music', () => {
    const clips = [{ start: 0, end: 2, speed: 1 }, { start: 5, end: 9, speed: 2 }];
    const argv = buildExportArgs({
      ...base,
      bundleDir: '/b',
      audioClips: clips,
      clicks: [1],
      music: [{ path: '/b/audio/m.mp3', delay: 0, sourceIn: 0, sourceOut: 3, length: 3, loop: false, gain: 1, fadeIn: 0, fadeOut: 0 }],
      phone: { path: '/b/phone.mov', offset: 1.25 },
      hasPhoneAudio: true,
    });
    // frames 0, recording 1, click tick 2, music 3, phone 4.
    expect(argv.join(' ')).toContain('-i /b/audio/m.mp3 -i /b/phone.mov -filter_complex');
    const f = filterOf(argv);
    expect(f).toContain('[4:a]adelay=delays=1250:all=1,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=2[ph0][ph1]');
    expect(f).toContain('[ph0]atrim=start=0.000:end=2.000,asetpts=PTS-STARTPTS,atempo=1[pc0]');
    expect(f).toContain('[ph1]atrim=start=5.000:end=9.000,asetpts=PTS-STARTPTS,atempo=2[pc1]');
    expect(f).toContain('[pc0][pc1]concat=n=2:v=0:a=1[phone]');
    expect(f).toMatch(/\[bed\]\[prog\]\[sfx\]\[m0\]\[phone\]amix=inputs=5/);
  });

  it('still exports the phone sound when the Mac recording has none', () => {
    const argv = buildExportArgs({ ...base, hasAudio: false, phone: { path: '/b/phone.mov', offset: 0 }, hasPhoneAudio: true });
    expect(filterOf(argv)).toMatch(/^\[2:a\]anull,.*\[phone\];anullsrc.*\[bed\]\[phone\]amix=inputs=2/);
    expect(phoneChain(2, 0)).toEqual(['[2:a]anull,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[phone]']);
  });
});
