// Inspector "Canvas" section for phone recordings: the output shape (a
// preset per destination) and, where the preset has room, a title card.
import React from 'react';
import type { Project } from '../../../shared/types';
import { LAYOUT_CHOICES, layoutPreset } from '../../../shared/mobileProject';
import { Section, Switch } from '../ui';
import './mobile.css';

/** Tile glyph proportions (w, h) for each choice. */
const SHAPES: Record<string, [number, number]> = {
  'social-9x16': [9, 16],
  'feed-4x5': [12, 15],
  square: [14, 14],
  'landscape-16x9': [18, 10.1],
  appstore: [8.8, 19],
  'landing-loop': [9, 16],
  none: [18, 11],
};

export function LayoutSection({
  proj,
  setProj,
  onTitleFocus,
}: {
  proj: Project;
  setProj: (fn: (p: Project) => Project) => void;
  /** The title fields gained or lost focus (the preview shows safe-zone guides meanwhile). */
  onTitleFocus: (focused: boolean) => void;
}) {
  const preset = layoutPreset(proj);
  const current = proj.layout.presetId.startsWith('appstore') ? 'appstore' : proj.layout.presetId;
  const title = proj.layout.titleCard;
  const setTitle = (patch: Partial<{ title: string; subtitle: string }>) =>
    setProj((p) => ({
      ...p,
      layout: { ...p.layout, titleCard: { title: '', subtitle: '', ...p.layout.titleCard, ...patch } },
    }));
  const focus = {
    onFocus: () => onTitleFocus(true),
    onBlur: () => onTitleFocus(false),
  };

  return (
    <Section
      title="Canvas"
      actions={preset && <span className="section-meta tnum">{preset.width} × {preset.height}</span>}
    >
      <div className="canvas-tiles" role="radiogroup" aria-label="Canvas">
        {LAYOUT_CHOICES.map((c) => {
          const [w, h] = SHAPES[c.id] ?? [12, 12];
          return (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={current === c.id}
              className={`canvas-tile${current === c.id ? ' on' : ''}`}
              title={c.id === 'appstore' ? 'App Store preview: exact size, no frame, no zoom' : c.label}
              onClick={() => setProj((p) => ({ ...p, layout: { ...p.layout, presetId: c.id } }))}
            >
              <span className="canvas-glyph">
                <span style={{ width: w * 1.6, height: h * 1.6 }} />
              </span>
              <span className="canvas-ratio tnum">{c.ratio}</span>
              <span className="canvas-label">{c.label}</span>
            </button>
          );
        })}
      </div>
      {preset?.id.startsWith('appstore') && (
        <p className="hint">
          App Store previews show the app's own UI at full size, so the frame, zoom and title card are off.
        </p>
      )}
      {preset?.titleCard && (
        <>
          <Switch
            label="Title card"
            hint="A headline beside the phone"
            checked={!!title}
            onChange={(v) =>
              setProj((p) => ({
                ...p,
                layout: { ...p.layout, titleCard: v ? { title: '', subtitle: '' } : undefined },
              }))
            }
          />
          {title && (
            <div className="title-fields">
              <input
                className="field"
                placeholder="Headline"
                aria-label="Title"
                value={title.title}
                onChange={(e) => setTitle({ title: e.target.value })}
                {...focus}
              />
              <input
                className="field"
                placeholder="Subtitle (optional)"
                aria-label="Subtitle"
                value={title.subtitle}
                onChange={(e) => setTitle({ subtitle: e.target.value })}
                {...focus}
              />
            </div>
          )}
        </>
      )}
    </Section>
  );
}
