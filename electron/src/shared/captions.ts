import type { CaptionCue } from './types';

/** `HH:MM:SS,mmm` or `HH:MM:SS.mmm` → seconds. */
function parseTs(ts: string): number {
  const m = ts.trim().match(/(?:(\d+):)?(\d+):(\d+)[,.](\d{1,3})/);
  if (!m) return 0;
  const [, h, min, s, ms] = m;
  return (h ? +h : 0) * 3600 + +min * 60 + +s + +ms / 1000;
}

/** Parse SRT or WebVTT text into caption cues. */
export function parseCaptions(text: string): CaptionCue[] {
  const src = text.replace(/\r/g, '');
  const cues: CaptionCue[] = [];
  // Split into blocks on blank lines; VTT's WEBVTT header and NOTE blocks are skipped.
  for (const block of src.split(/\n\n+/)) {
    const lines = block.split('\n').map((l) => l.trimEnd());
    if (!lines.length || /^WEBVTT|^NOTE\b/i.test(lines[0])) continue;
    // Find the timestamp line (SRT has an index line first).
    const ti = lines.findIndex((l) => /-->/u.test(l));
    if (ti < 0) continue;
    const [startRaw, endRaw] = lines[ti].split('-->');
    const start = parseTs(startRaw);
    const end = parseTs(endRaw);
    if (!(end > start)) continue;
    const text = lines
      .slice(ti + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (!text) continue;
    cues.push({ id: crypto.randomUUID(), start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** Serialize cues to SRT. */
export function toSrt(cues: CaptionCue[]): string {
  const fmt = (t: number) => {
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const ms = Math.round((t % 1) * 1000);
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
  };
  return cues
    .map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}`)
    .join('\n\n') + '\n';
}
