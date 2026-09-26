import { describe, expect, it, vi } from 'vitest';
import {
  alignToVideoStart,
  cameraLabel,
  captureErrorMessage,
  createStopLatch,
  cursorModeFor,
  findWhisperCli,
  normalizeToDisplay,
  parseFfmpegDuration,
  parseFfmpegVideoSize,
  partialPath,
  pickDisplay,
  sourceKindFor,
  withProbedDuration,
  type StoppableRecorder,
} from '../src/shared/recording';
import { defaultProject } from '../src/shared/types';

/** A MediaRecorder stand-in: stop() fires onstop asynchronously, like Chromium. */
function fakeRecorder(): StoppableRecorder & { endByItself(): void; stopCalls: number } {
  const r = {
    state: 'recording' as StoppableRecorder['state'],
    onstop: null as StoppableRecorder['onstop'],
    stopCalls: 0,
    stop() {
      r.stopCalls++;
      if (r.state === 'inactive') return; // Chromium: no event when already inactive
      r.state = 'inactive';
      queueMicrotask(() => r.onstop?.({} as Event));
    },
    // The only track ended: Chromium stops the recorder on its own.
    endByItself() {
      r.state = 'inactive';
      r.onstop?.({} as Event);
    },
  };
  return r;
}

describe('createStopLatch (BH-05)', () => {
  it('stops a running recorder and resolves on onstop', async () => {
    const rec = fakeRecorder();
    const latch = createStopLatch(rec);
    await latch.stop();
    expect(rec.stopCalls).toBe(1);
    expect(latch.stopped).toBe(true);
  });

  it('does not hang when the recorder already stopped by itself (window closed)', async () => {
    const rec = fakeRecorder();
    const onEnded = vi.fn();
    const latch = createStopLatch(rec, onEnded);
    rec.endByItself();
    expect(onEnded).toHaveBeenCalledTimes(1);
    const result = await Promise.race([latch.stop().then(() => 'done'), new Promise((r) => setTimeout(() => r('hung'), 50))]);
    expect(result).toBe('done');
    expect(rec.stopCalls).toBe(0);
  });

  it('does not hang on an inactive recorder whose onstop never fires', async () => {
    const rec = fakeRecorder();
    rec.state = 'inactive';
    const latch = createStopLatch(rec);
    const result = await Promise.race([latch.stop().then(() => 'done'), new Promise((r) => setTimeout(() => r('hung'), 50))]);
    expect(result).toBe('done');
  });

  it('control: the old attach-at-stop pattern hangs in the same situation', async () => {
    const rec = fakeRecorder();
    rec.endByItself(); // fired before anyone listened
    const done = new Promise<void>((r) => (rec.onstop = () => r()));
    rec.stop();
    const result = await Promise.race([done.then(() => 'done'), new Promise((r) => setTimeout(() => r('hung'), 50))]);
    expect(result).toBe('hung');
  });

  it('a user stop is not reported as stopping by itself, and repeat stops are safe', async () => {
    const rec = fakeRecorder();
    const onEnded = vi.fn();
    const latch = createStopLatch(rec, onEnded);
    await Promise.all([latch.stop(), latch.stop()]);
    await latch.stop();
    expect(onEnded).not.toHaveBeenCalled();
    expect(rec.stopCalls).toBe(1);
  });
});

describe('source kinds and cursor mode (BH-10)', () => {
  it('maps capture ids', () => {
    expect(sourceKindFor('screen:1:0')).toBe('display');
    expect(sourceKindFor('window:4242:0')).toBe('window');
    expect(cursorModeFor('screen:1:0')).toBe('display');
    expect(cursorModeFor('window:4242:0')).toBe('none');
    expect(cursorModeFor('3f9a0c-camera-device-id')).toBe('none');
  });

  const displays = [
    { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 } },
    { id: 2, bounds: { x: 1512, y: -200, width: 2560, height: 1440 } },
  ];

  it('picks the recorded display by display_id, not the one under the pointer', () => {
    expect(pickDisplay(displays, '2', displays[0]).id).toBe(2);
    expect(pickDisplay(displays, '', displays[0]).id).toBe(1);
    expect(pickDisplay(displays, '99', displays[1]).id).toBe(2);
  });

  it('normalizes to the recorded display and drops points on another display', () => {
    const second = displays[1].bounds;
    expect(normalizeToDisplay({ x: 1512 + 1280, y: -200 + 720 }, second)).toEqual({ x: 0.5, y: 0.5 });
    // Pointer on the built-in screen while the external one is recorded.
    expect(normalizeToDisplay({ x: 756, y: 491 }, second)).toBeNull();
  });
});

describe('alignToVideoStart (BH-11)', () => {
  it('shifts samples onto the video clock and drops ones from before it started', () => {
    const samples = [
      { time: 0.1, x: 0, y: 0 },
      { time: 0.5, x: 0, y: 0 },
      { time: 2.0, x: 0, y: 0 },
    ];
    expect(alignToVideoStart(samples, 0.4).map((s) => +s.time.toFixed(3))).toEqual([0.1, 1.6]);
    expect(alignToVideoStart(samples, 0)).toBe(samples);
    expect(alignToVideoStart(samples, Number.NaN)).toBe(samples);
  });
});

describe('probed duration (BH-11/BH-12)', () => {
  it('parses ffmpeg banners', () => {
    expect(parseFfmpegDuration('  Duration: 00:01:02.35, start: 0.000000, bitrate: 1 kb/s')).toBeCloseTo(62.35);
    expect(parseFfmpegDuration('  Duration: N/A, start: 0.000000, bitrate: N/A')).toBeNull();
    expect(
      parseFfmpegVideoSize('  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv), 1179x2556, 9000 kb/s'),
    ).toEqual({ width: 1179, height: 2556 });
  });

  it("replaces a fresh take's wall-clock duration and stretches its single clip", () => {
    const p = defaultProject({ screenVideoFile: 'screen.webm', sourceKind: 'display', sourceSize: { width: 1, height: 1 }, duration: 5.75 });
    const out = withProbedDuration(p, 6.03);
    expect(out.recording.duration).toBe(6.03);
    expect(out.clips).toEqual([{ ...p.clips[0], sourceEnd: 6.03 }]);
    expect(withProbedDuration(p, null)).toBe(p);
  });

  it('leaves edited clips alone', () => {
    const p = defaultProject({ screenVideoFile: 'screen.webm', sourceKind: 'display', sourceSize: { width: 1, height: 1 }, duration: 5 });
    p.clips = [{ id: 'a', sourceStart: 1, sourceEnd: 3, speed: 1 }];
    expect(withProbedDuration(p, 6).clips).toBe(p.clips);
  });
});

describe('small helpers', () => {
  it('keeps unlabeled cameras with a readable name (BH-09)', () => {
    expect(cameraLabel({ label: '' }, 1)).toBe('Camera 2');
    expect(cameraLabel({ label: 'FaceTime HD Camera' }, 0)).toBe('FaceTime HD Camera');
  });

  it('turns capture errors into sentences (BH-17/BH-25)', () => {
    const e = Object.assign(new Error('Could not start video source'), { name: 'NotReadableError' });
    expect(captureErrorMessage(e, 'Notes')).toMatch(/Couldn't capture "Notes"\. It may have closed/);
    expect(captureErrorMessage(Object.assign(new Error('x'), { name: 'NotAllowedError' }))).toMatch(/Screen Recording/);
    expect(captureErrorMessage(new Error("Error invoking remote method 'recording:start': Error: boom"))).toBe(
      "Couldn't start recording: boom",
    );
  });

  it('finds whisper-cli in Homebrew prefixes before PATH (BH-22)', () => {
    const has = (set: string[]) => (p: string) => set.includes(p);
    expect(findWhisperCli(has(['/usr/local/bin/whisper-cli']), ['/usr/bin'])).toBe('/usr/local/bin/whisper-cli');
    expect(findWhisperCli(has(['/opt/tools/whisper-cli']), ['/usr/bin', '/opt/tools/'])).toBe('/opt/tools/whisper-cli');
    expect(findWhisperCli(has([]), ['/usr/bin'])).toBeNull();
    expect(partialPath('/m/ggml-base.en.bin')).toBe('/m/ggml-base.en.bin.part');
  });
});
