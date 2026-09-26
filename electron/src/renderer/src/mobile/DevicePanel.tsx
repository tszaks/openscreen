// Inspector "Device" tab for phone recordings: the hardware frame (model and
// finish), how touches are drawn, and the taps / waits found in the video.
import React from 'react';
import type { Project, TapStyle } from '../../../shared/types';
import { DEVICES, getFinish } from '../../../shared/devices';
import type { ResolvedDevice } from '../../../shared/mobileProject';
import { Button, Section, Segmented, Switch } from '../ui';
import { ScrubField } from '../components/ScrubField';
import './mobile.css';

export function DevicePanel({
  proj,
  setProj,
  onCommit,
  resolved,
  analyzing,
  onRedetect,
  pendingWaits,
  onSpeedUpWaits,
  onCutWaits,
}: {
  proj: Project;
  setProj: (fn: (p: Project) => Project) => void;
  /** Ends an undo step (after a scrub gesture). */
  onCommit: () => void;
  resolved: ResolvedDevice;
  analyzing: boolean;
  onRedetect: () => void;
  /** Waits still playing at 1x: how many and how long. */
  pendingWaits: { count: number; seconds: number };
  onSpeedUpWaits: () => void;
  onCutWaits: () => void;
}) {
  const { device, detected, candidates } = resolved;
  const finish = getFinish(device, proj.device.finishId);
  const setDevice = (patch: Partial<Project['device']>) =>
    setProj((p) => ({ ...p, device: { ...p.device, ...patch } }));
  const setTapStyle = (patch: Partial<TapStyle>) =>
    setProj((p) => ({ ...p, tapStyle: { ...p.tapStyle, ...patch } }));
  // The detected panel's models first, then everything else of the same family.
  const others = DEVICES.filter((d) => d.family === detected.family && !candidates.some((c) => c.id === d.id));
  const pickModel = (id: string) =>
    // A finish only means something on its own model.
    setDevice({ modelId: id === detected.id ? undefined : id, finishId: undefined });
  const counts = proj.taps.reduce<Record<string, number>>((m, t) => ({ ...m, [t.kind]: (m[t.kind] ?? 0) + 1 }), {});
  const summary = [
    counts.tap && `${counts.tap} tap${counts.tap === 1 ? '' : 's'}`,
    counts.swipe && `${counts.swipe} swipe${counts.swipe === 1 ? '' : 's'}`,
    counts.longpress && `${counts.longpress} long press${counts.longpress === 1 ? '' : 'es'}`,
    counts.typing && `${counts.typing} typing`,
  ].filter(Boolean).join(', ');

  return (
    <>
      <Section title="Frame">
        <Switch
          label="Device frame"
          hint="Draw the phone's hardware around the recording"
          checked={proj.device.frame}
          onChange={(v) => setDevice({ frame: v })}
        />
        {proj.device.frame && (
          <>
            <div className="model-list" role="radiogroup" aria-label="Device model">
              {candidates.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={device.id === m.id}
                  className={`model-row${device.id === m.id ? ' on' : ''}`}
                  onClick={() => pickModel(m.id)}
                >
                  <span className="model-name">{m.name}</span>
                  {m.id === detected.id && <span className="badge">Detected</span>}
                </button>
              ))}
              {!candidates.some((c) => c.id === device.id) && (
                <div className="model-row on" role="radio" aria-checked>
                  <span className="model-name">{device.name}</span>
                </div>
              )}
            </div>
            {others.length > 0 && (
              <select
                className="field select"
                aria-label="Other model"
                value=""
                onChange={(e) => e.target.value && pickModel(e.target.value)}
              >
                <option value="">Other model…</option>
                {others.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}
            <div className="field-block">
              <span className="row-label">
                Finish <span className="row-hint finish-name">{finish.name}</span>
              </span>
              <div className="finishes" role="radiogroup" aria-label="Finish">
                {device.finishes.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    role="radio"
                    aria-checked={finish.id === f.id}
                    aria-label={f.name}
                    title={f.name}
                    className={`finish${finish.id === f.id ? ' on' : ''}`}
                    style={{ '--finish': f.hex } as React.CSSProperties}
                    onClick={() => setDevice({ finishId: f.id })}
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </Section>

      <Section title="Touches">
        <Switch
          label="Show touches"
          hint="Draw a fingertip at each tap and swipe"
          checked={proj.tapStyle.show}
          onChange={(v) => setTapStyle({ show: v })}
        />
        {proj.tapStyle.show && (
          <>
            <div className="field-block">
              <span className="row-label">Style</span>
              <Segmented
                label="Touch style"
                value={proj.tapStyle.style}
                options={[
                  { value: 'ripple', label: 'Ripple' },
                  { value: 'pulse', label: 'Pulse' },
                  { value: 'ring', label: 'Ring' },
                ]}
                onChange={(style) => setTapStyle({ style })}
              />
            </div>
            <div className="field-block">
              <span className="row-label">Color</span>
              <Segmented
                label="Touch color"
                value={proj.tapStyle.color}
                options={[
                  { value: 'white', label: <><span className="dot white" />White</> },
                  { value: 'accent', label: <><span className="dot accent" />Accent</> },
                ]}
                onChange={(color) => setTapStyle({ color })}
              />
            </div>
            <ScrubField
              label="Size"
              min={32}
              max={96}
              step={1}
              unit="pt"
              value={proj.tapStyle.sizePt}
              onChange={(sizePt) => setTapStyle({ sizePt })}
              onCommit={onCommit}
            />
          </>
        )}
      </Section>

      <Section
        title="Taps"
        actions={
          <Button size="sm" variant="ghost" disabled={analyzing} onClick={onRedetect} title="Replace the taps track with fresh suggestions from the video">
            {analyzing ? 'Finding taps…' : 'Re-detect taps'}
          </Button>
        }
      >
        <p className="hint tnum">
          {analyzing
            ? 'Reading the recording for taps and swipes…'
            : summary
              ? `${summary} on the taps track.`
              : 'No taps yet.'}
        </p>
        <p className="hint">
          Drag a marker to retime it. Select one, then click the preview to move it. Option-click the lane
          to add one, right-click to remove.
        </p>
      </Section>

      <Section title="Waits">
        {pendingWaits.count > 0 ? (
          <>
            <p className="hint tnum">
              {pendingWaits.count} still stretch{pendingWaits.count === 1 ? '' : 'es'}, {pendingWaits.seconds.toFixed(1)}s
              where nothing moves.
            </p>
            <div className="toolbar">
              <Button size="sm" variant="primary" onClick={onSpeedUpWaits} title="Play every wait at 3x speed">
                Speed up waits
              </Button>
              <Button size="sm" variant="ghost" onClick={onCutWaits} title="Cut every wait from the video">
                Cut waits
              </Button>
            </div>
          </>
        ) : (
          <p className="hint">{proj.waits.length ? 'Every wait is sped up or cut.' : 'No still stretches found.'}</p>
        )}
      </Section>
    </>
  );
}
