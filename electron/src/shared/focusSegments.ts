// Every zoom the editor plays, from one place (D5): autofocus (clicks,
// dwells, touches), tap zooms and manual zooms, in that order, sorted by
// start. This is the Editor's `segments` memo moved as is, so the editor,
// the CLI (warnings, Auto 3D) and the compositor all see the same list.
// A new file so it can import autofocus, taps and the timeline without an
// import cycle.

import { AutofocusPlanner, defaultAutofocus, dwellFocusEvents, type FocusSegment } from './autofocus';
import { planTapZoom } from './autozoomTaps';
import { isPhoneProject, layoutPreset, presetAllowsZoom, tapsToOutput } from './mobileProject';
import { Timeline, toOutputTime } from './timeline';
import type { CursorSample, Project } from './types';

/**
 * The zoom segments for `p` in output time: [] on an App Store preview;
 * otherwise autofocus segments (when zoom.autofocus) from the cursor's
 * click-downs, its dwells (when zoom.dwell) and zoom.motionEvents, then tap
 * zooms (iPhone takes with zoom.fromTaps), then manual zooms, stably sorted
 * by inStart. `durationFallback` stands in for an empty timeline's length
 * (the editor passes the video's duration).
 */
export function focusSegmentsFor(
  p: Pick<Project, 'recording' | 'clips' | 'layout' | 'device' | 'zoom' | 'taps' | 'manualZooms'>,
  cursor: readonly CursorSample[] = [],
  durationFallback: number = p.recording.duration,
): FocusSegment[] {
  if (!presetAllowsZoom(layoutPreset(p))) return [];
  const tl = new Timeline(p.recording.duration, p.clips);
  const length = tl.outputDuration || durationFallback;
  const taps = isPhoneProject(p) && p.zoom.fromTaps ? planTapZoom(tapsToOutput(p.taps, tl), length, { scale: p.zoom.depth }) : [];
  const auto = p.zoom.autofocus
    ? new AutofocusPlanner({ ...defaultAutofocus, maxScale: p.zoom.depth }).planSegments(
        // Clicks, dwells and touches are source time; zooms play in output time.
        toOutputTime(
          [
            ...cursor.filter((s) => s.kind === 'clickDown'),
            ...(p.zoom.dwell ? dwellFocusEvents([...cursor]) : []),
            ...p.zoom.motionEvents,
          ],
          tl,
        ),
        length,
      )
    : [];
  return [...auto, ...taps, ...p.manualZooms].sort((a, b) => a.inStart - b.inStart);
}
