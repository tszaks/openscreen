// The Export menu's layout-preset branch (D18): it shows the preset's Resolution picker the editor passes in,
// and its hint states the size the export will write (4K scales social and web presets), not the preset's
// own size. Rendered to markup with React's server renderer (no DOM needed).
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExportPanel, type ExportPanelProps } from '../src/renderer/src/components/ExportPanel';
import { presetCanvasSize } from '../src/shared/exportArgs';
import { getPreset } from '../src/shared/exportPresets';

const social = getPreset('social-9x16');

function render(over: Partial<ExportPanelProps>): string {
  const props: ExportPanelProps = {
    layoutPreset: social,
    singleSettings: createElement('i', { 'data-single': '' }),
    presetSize: presetCanvasSize(social, 'p1080'),
    presetSettings: createElement('i', { 'data-preset-resolution': '' }),
    choices: [],
    selected: [],
    warnings: {},
    disabled: false,
    onToggle: () => {},
    onExportSingle: () => {},
    onExportFormats: () => {},
    ...over,
  };
  return renderToStaticMarkup(createElement(ExportPanel, props));
}

describe('Export menu with a layout preset', () => {
  it('the hint states the size the export writes: the preset size at 1080p, 2160×3840 at 4K', () => {
    expect(render({})).toContain(`Uses the ${social.label} layout: 1080x1920, 30 fps.`);
    const uhd = presetCanvasSize(social, 'uhd4k');
    expect(uhd).toEqual({ width: 2160, height: 3840 });
    expect(render({ presetSize: uhd })).toContain(`Uses the ${social.label} layout: 2160x3840, 30 fps.`);
  });

  it('shows the preset Resolution picker and not the classic pickers; without a preset, the reverse', () => {
    const withPreset = render({});
    expect(withPreset).toContain('data-preset-resolution');
    expect(withPreset).not.toContain('data-single');
    const classic = render({ layoutPreset: null, presetSize: null });
    expect(classic).toContain('data-single');
    expect(classic).not.toContain('data-preset-resolution');
  });
});
