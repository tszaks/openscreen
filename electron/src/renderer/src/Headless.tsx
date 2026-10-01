import React, { useEffect, useState } from 'react';
import { api, type OpenedBundle } from './api';
import { Editor } from './Editor';

/**
 * The renderer for `OpenScreen --export` (the window is never shown): open
 * the job's bundle and mount the real Editor, which exports through the same
 * compositor and ffmpeg path as the Export button, then reports to main.
 * Nothing here touches the picker (no source listing, iPhone polling or
 * recovery scans).
 */
export function Headless() {
  const [job, setJob] = useState<{ bundle: OpenedBundle; out: string; gif: boolean; presets?: string[] } | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const j = await api.headlessJob();
        if (!j) throw new Error('no headless job');
        const bundle = await api.headlessOpen();
        setJob({ bundle, out: j.out, gif: j.gif, presets: j.presets });
      } catch (e) {
        api.headlessDone({ ok: false, error: String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
      }
    })();
  }, []);
  if (!job) return null;
  const b = job.bundle;
  return (
    <Editor
      videoUrl={b.videoUrl}
      camUrl={b.camUrl}
      phoneUrl={b.phoneUrl}
      project={b.project}
      cursor={b.cursor}
      keys={b.keys}
      bundleDir={b.bundleDir}
      onNewRecording={() => {}}
      onOpenProject={() => {}}
      headless={{ out: job.out, gif: job.gif, presets: job.presets }}
    />
  );
}
