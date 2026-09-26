import type { IosWarning } from '../../../shared/iosCapture';

// Pure logic for the iPhone setup checklist and the mid-take stall warning.
// Steps follow the pre-flight checklist in the wired-capture research.

export interface SetupStep {
  id: 'cable' | 'trust' | 'focus' | 'unlocked' | 'orientation';
  title: string;
  body: string;
}

export const IOS_SETUP_STEPS: readonly SetupStep[] = [
  {
    id: 'cable',
    title: 'Connect with a data cable',
    body:
      "Use the cable that came with your iPhone, or another one that carries data. A charge-only cable powers the phone, but it never shows up here.",
  },
  {
    id: 'trust',
    title: 'Unlock your iPhone and tap Trust',
    body:
      'When the phone asks whether to trust this Mac, tap Trust and enter your passcode. If you just tapped Trust, unplug the cable and plug it back in to finish setup.',
  },
  {
    id: 'focus',
    title: 'Turn on Do Not Disturb',
    body:
      "Open Control Center and turn on a Focus such as Do Not Disturb, so notifications and calls don't appear in your recording.",
  },
  {
    id: 'unlocked',
    title: 'Keep the phone unlocked while you record',
    body:
      "A locked phone freezes the picture. Don't tap Stop Mirroring in Control Center either: the phone then sends no picture until you restart it.",
  },
  {
    id: 'orientation',
    title: 'Choose portrait or landscape first',
    body:
      'Turn the phone the way you want it before you press Start. Rotating it during a take can end the recording.',
  },
];

const stepIndex = (id: SetupStep['id']) => IOS_SETUP_STEPS.findIndex((s) => s.id === id);

/**
 * The step that fixes a failed start, or null when the checklist wouldn't
 * help. "no-frames" means the session opened but no picture came: a locked
 * phone, a fresh Trust that needs a replug, or Stop Mirroring. The unlock
 * and Trust step covers the first two and the helper's message names the
 * third. A start that timed out before its first frame is the same story.
 */
export function stepForStartError(code: string | undefined, message: string): number | null {
  if (code === 'no-frames') return stepIndex('trust');
  if (/did not start sending video/i.test(message)) return stepIndex('trust');
  return null;
}

export interface SetupPrefs {
  /** "Don't show again" was pressed. */
  hidden: boolean;
  /** The checklist has been shown for a first iPhone pick. */
  seen: boolean;
}

export type SetupTrigger =
  | { kind: 'firstUse' }
  | { kind: 'startError'; code?: string; message: string };

/**
 * Whether a trigger opens the checklist, and at which step. A first pick
 * opens it once, unless it was hidden. A failed start opens it whenever a
 * step can help, even if hidden, since the user is stuck right now.
 */
export function checklistFor(
  trigger: SetupTrigger,
  prefs: SetupPrefs,
): { step: number; message: string | null } | null {
  if (trigger.kind === 'firstUse') {
    return prefs.hidden || prefs.seen ? null : { step: 0, message: null };
  }
  const step = stepForStartError(trigger.code, trigger.message);
  return step === null ? null : { step, message: trigger.message };
}

const HIDDEN_KEY = 'openscreen.iosSetup.hidden';
const SEEN_KEY = 'openscreen.iosSetup.seen';

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;

export function readSetupPrefs(store: KeyValue): SetupPrefs {
  try {
    return { hidden: store.getItem(HIDDEN_KEY) === '1', seen: store.getItem(SEEN_KEY) === '1' };
  } catch {
    return { hidden: false, seen: false };
  }
}

export function writeSetupPref(store: KeyValue, key: keyof SetupPrefs) {
  try {
    store.setItem(key === 'hidden' ? HIDDEN_KEY : SEEN_KEY, '1');
  } catch {}
}

export const STALLED_TEXT = 'Your iPhone may be locked. Unlock it to keep recording.';

/**
 * The warning to show during an iPhone take, from the helper's current
 * warning. "stalled" gets our calm copy; another code shows the helper's
 * own message; no warning (or "resumed") clears it.
 */
export function recordingWarning(w: IosWarning | null | undefined): string | null {
  if (!w || w.code === 'resumed') return null;
  if (w.code === 'stalled') return STALLED_TEXT;
  return w.message?.trim() || null;
}

/** m:ss for the recording timer. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
