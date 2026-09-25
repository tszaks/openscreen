import type { KeystrokeSample } from './types';

/** Keys pressed within `windowSecs` before `t`, oldest→newest, with
 *  consecutive duplicates collapsed (held-key repeats). At most 3 shown. */
export function keysAt(t: number, keys: KeystrokeSample[], windowSecs = 1.4): string[] {
  const recent: string[] = [];
  for (const k of keys) {
    if (k.time > t) break;
    if (k.time > t - windowSecs && recent[recent.length - 1] !== k.key) {
      recent.push(k.key);
    }
  }
  return recent.slice(-3);
}
