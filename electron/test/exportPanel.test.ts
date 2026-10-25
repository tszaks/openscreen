// The Export menu's layout-preset branch (D18): it shows the preset's Resolution picker (not for App Store presets),
// and its hint states the size the export will write (4K scales social and web presets), not the preset's own size.
// Rendered to markup with React's server renderer (no DOM needed).
// Integration: WP5 owns ExportPanel.tsx; these are WP6's checks against WP5's props (exportPreset + onResolution).
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExportPanel, type ExportPanelProps } from '../src/renderer/src/components/ExportPanel';
import { presetCanvasSize } from '../src/shared/exportArgs';
import { getPreset } from '../src/shared/exportPresets';

const social = getPreset('social-9x16');
const appStore = getPreset('appstore-iphone');

function render(over: Partial<ExportPanelProps>): string {
  const props: ExportPanelProps = {
    layoutPreset: social,
    exportPreset: 'p1080',
    onResolution: () => {},
    singleSettings: createElement('i', { 'data-single': '' }),
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
  it('the hint states the size the export writes: the preset size at 1080p, 2160x3840 at 4K', () => {
    expect(render({})).toContain(`Uses the ${social.label} layout: 1080x1920, 30 fps.`);
    const uhd = presetCanvasSize(social, 'uhd4k');
    expect(uhd).toEqual({ width: 2160, height: 3840 });
    expect(render({ exportPreset: 'uhd4k' })).toContain(`Uses the ${social.label} layout: 2160x3840, 30 fps.`);
  });

  it('shows the preset Resolution picker and not the classic pickers; without a preset, the reverse', () => {
    const withPreset = render({});
    expect(withPreset).toContain('Resolution');
    expect(withPreset).toContain('4K');
    expect(withPreset).not.toContain('data-single');
    const classic = render({ layoutPreset: null });
    expect(classic).toContain('data-single');
    expect(classic).not.toContain('Resolution');
  });

  it('an App Store preset keeps its own size: no Resolution picker, and 4K does not scale it', () => {
    const html = render({ layoutPreset: appStore, exportPreset: 'uhd4k' });
    expect(html).not.toContain('Resolution');
    expect(html).toContain(`${appStore.width}x${appStore.height}`);
  });
});
