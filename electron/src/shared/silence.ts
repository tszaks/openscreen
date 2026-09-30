// ffmpeg silencedetect: the one set of arguments and the one parser, shared
// by the editor's Smart cut (main process) and the agent CLI.

export const DEFAULT_SILENCE_DB = 35;
export const DEFAULT_SILENCE_MIN = 0.4;

/** 16 kHz mono wav from a bundle video (for silencedetect and whisper). */
export const extractWavArgs = (video: string, wav: string) => [
  '-y', '-i', video, '-vn', '-ar', '16000', '-ac', '1', '-f', 'wav', wav,
];

export const silenceDetectArgs = (input: string, thresholdDb = DEFAULT_SILENCE_DB, minDur = DEFAULT_SILENCE_MIN) => [
  '-i', input, '-af', `silencedetect=n=-${Math.abs(thresholdDb)}dB:d=${minDur}`, '-f', 'null', '-',
];

/** silencedetect stderr → [{start,end}] in seconds. An unterminated silence runs to `until`. */
export function parseSilences(stderr: string, until?: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let cur: number | null = null;
  for (const m of stderr.matchAll(/silence_(start|end):\s*(-?[\d.]+)/g)) {
    if (m[1] === 'start') cur = Math.max(0, parseFloat(m[2]));
    else if (cur !== null) {
      out.push({ start: cur, end: parseFloat(m[2]) });
      cur = null;
    }
  }
  if (cur !== null && until !== undefined && until > cur) out.push({ start: cur, end: until });
  return out;
}

/** freezedetect stderr → still stretches [{start,end}] (seconds). */
export function parseFreezes(stderr: string, until?: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let cur: number | null = null;
  for (const m of stderr.matchAll(/freeze_(start|end):\s*(-?[\d.]+)/g)) {
    if (m[1] === 'start') cur = Math.max(0, parseFloat(m[2]));
    else if (cur !== null) {
      out.push({ start: cur, end: parseFloat(m[2]) });
      cur = null;
    }
  }
  if (cur !== null && until !== undefined && until > cur) out.push({ start: cur, end: until });
  return out;
}
