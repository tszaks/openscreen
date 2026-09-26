import { describe, expect, it } from 'vitest';
import {
  IOS_SETUP_STEPS,
  STALLED_TEXT,
  checklistFor,
  formatElapsed,
  readSetupPrefs,
  recordingWarning,
  stepForStartError,
  writeSetupPref,
} from '../src/renderer/src/components/iosSetup';
import { decodeIosError, encodeIosError } from '../src/shared/iosErrors';

const NO_FRAMES =
  "No picture from your iPhone. Unlock it and keep the screen on. If you just tapped Trust, unplug and replug the cable. If that doesn't help, restart the iPhone.";
const trustStep = IOS_SETUP_STEPS.findIndex((s) => s.id === 'trust');

function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe('iPhone setup steps', () => {
  it('has the five pre-flight steps in order', () => {
    expect(IOS_SETUP_STEPS.map((s) => s.id)).toEqual(['cable', 'trust', 'focus', 'unlocked', 'orientation']);
  });

  it('uses no em dashes in its copy', () => {
    for (const s of IOS_SETUP_STEPS) expect(`${s.title} ${s.body}`).not.toMatch(/—/);
  });
});

describe('stepForStartError', () => {
  it('sends no-frames to the unlock and Trust step', () => {
    expect(stepForStartError('no-frames', NO_FRAMES)).toBe(trustStep);
  });

  it('treats a start that timed out before its first frame the same way', () => {
    expect(stepForStartError(undefined, 'The device did not start sending video. Unlock it and try again.')).toBe(trustStep);
  });

  it('ignores errors the checklist cannot fix', () => {
    expect(stepForStartError(undefined, 'Camera permission is needed to record an iPhone.')).toBeNull();
    expect(stepForStartError('device-gone', 'The iPhone was disconnected.')).toBeNull();
  });
});

describe('checklistFor', () => {
  const fresh = { hidden: false, seen: false };

  it('opens at the first step on a first iPhone pick', () => {
    expect(checklistFor({ kind: 'firstUse' }, fresh)).toEqual({ step: 0, message: null });
  });

  it('does not reopen for a first pick once seen or hidden', () => {
    expect(checklistFor({ kind: 'firstUse' }, { hidden: false, seen: true })).toBeNull();
    expect(checklistFor({ kind: 'firstUse' }, { hidden: true, seen: false })).toBeNull();
  });

  it('opens on no-frames with the helper message, even when hidden', () => {
    const r = checklistFor({ kind: 'startError', code: 'no-frames', message: NO_FRAMES }, { hidden: true, seen: true });
    expect(r).toEqual({ step: trustStep, message: NO_FRAMES });
  });

  it('stays closed for an unrelated start error', () => {
    expect(checklistFor({ kind: 'startError', message: 'Camera permission is needed.' }, fresh)).toBeNull();
  });
});

describe('setup prefs', () => {
  it('round-trips through storage', () => {
    const store = memoryStore();
    expect(readSetupPrefs(store)).toEqual({ hidden: false, seen: false });
    writeSetupPref(store, 'seen');
    expect(readSetupPrefs(store)).toEqual({ hidden: false, seen: true });
    writeSetupPref(store, 'hidden');
    expect(readSetupPrefs(store)).toEqual({ hidden: true, seen: true });
  });

  it('falls back to defaults when storage throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(readSetupPrefs(broken)).toEqual({ hidden: false, seen: false });
    expect(() => writeSetupPref(broken, 'hidden')).not.toThrow();
  });
});

describe('recordingWarning', () => {
  it('shows the calm lock copy while stalled', () => {
    expect(recordingWarning({ code: 'stalled', message: 'helper text' })).toBe(STALLED_TEXT);
  });

  it('clears on resume or when the warning goes away', () => {
    expect(recordingWarning({ code: 'resumed' })).toBeNull();
    expect(recordingWarning(null)).toBeNull();
    expect(recordingWarning(undefined)).toBeNull();
  });

  it("shows an unknown warning's own message, or nothing", () => {
    expect(recordingWarning({ code: 'low-fps', message: 'Frames are dropping.' })).toBe('Frames are dropping.');
    expect(recordingWarning({ code: 'low-fps' })).toBeNull();
  });

  it('follows a stall and its recovery across polls', () => {
    const polls = [null, { code: 'stalled' }, { code: 'stalled' }, null];
    expect(polls.map(recordingWarning)).toEqual([null, STALLED_TEXT, STALLED_TEXT, null]);
  });
});

describe('iOS error codes across IPC', () => {
  it('round-trips a code through the message', () => {
    const wire = encodeIosError(NO_FRAMES, 'no-frames');
    // Electron prefixes rejected invoke messages; the renderer strips that first.
    expect(decodeIosError(wire)).toEqual({ code: 'no-frames', message: NO_FRAMES });
  });

  it('leaves an uncoded message alone', () => {
    expect(encodeIosError('plain')).toBe('plain');
    expect(decodeIosError('plain [ios:x] later')).toEqual({ message: 'plain [ios:x] later' });
  });
});

describe('formatElapsed', () => {
  it('formats m:ss', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(9.9)).toBe('0:09');
    expect(formatElapsed(75)).toBe('1:15');
    expect(formatElapsed(-3)).toBe('0:00');
  });
});
