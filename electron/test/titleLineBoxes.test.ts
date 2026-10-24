// The title card as its drawn lines (renderer/src/titleLineBoxes.ts): the
// 4K-downscale check (owner decision 8) compares and masks each title and
// subtitle line, so every box must sit exactly where drawTitleCard drew that
// line, in the font it drew it with. Each case draws a card with the real
// drawTitleCard on a recording mock canvas and checks every line box
// against its fillText call and the font and letterSpacing set before it.
// A change to how the card draws (the baseline walk, the centring nudge, a
// font) fails here.
import { describe, expect, it } from 'vitest';
import { mockCanvas } from './helpers/mockCanvas';
import { createHarness, loadGoldenFixture } from './helpers/compositorHarness';
import { drawTitleCard } from '../src/renderer/src/mobile/layout';
import { layoutRefScale, splitTitleCards, titleLineBoxes, titleLineFont, type MeasureText } from '../src/renderer/src/titleLineBoxes';
import { projectCanvasSize } from '../src/shared/mobileProject';
import { phoneProject } from './helpers/phone3dFixtures';
import type { TextBox } from '../src/shared/textBoxes';

/** What the mock canvas measures: half the font size per character. */
const mockMeasure: MeasureText = (font, _ls, text) => text.length * Number(font.match(/(\d+(?:\.\d+)?)px/)![1]) * 0.5;

interface Drawn {
  text: string;
  x: number;
  y: number;
  font: string;
  letterSpacing: string;
}

/** Every fillText in `calls`, with the font and letterSpacing in effect. */
function fills(calls: { name: string; args: unknown[] }[]): Drawn[] {
  let font = '';
  let letterSpacing = '';
  const out: Drawn[] = [];
  for (const c of calls) {
    if (c.name === 'set:font') font = String(c.args[0]);
    else if (c.name === 'set:letterSpacing') letterSpacing = String(c.args[0]);
    else if (c.name === 'fillText') out.push({ text: String(c.args[0]), x: Number(c.args[1]), y: Number(c.args[2]), font, letterSpacing });
  }
  return out;
}

/** Each line box against the fillText that drew it: same text, font, tracking, anchor x and baseline. */
function expectLinesMatch(boxes: TextBox[], drawn: Drawn[], card: { titlePx: number; subtitlePx: number; titleLines: string[]; align: 'center' | 'left' }) {
  expect(boxes.map((b) => b.text)).toEqual(drawn.map((d) => d.text));
  boxes.forEach((b, i) => {
    const d = drawn[i];
    const part = i < card.titleLines.length ? 'title' : 'subtitle';
    const px = part === 'title' ? card.titlePx : card.subtitlePx;
    expect(titleLineFont(part, px)).toEqual({ font: d.font, letterSpacing: d.letterSpacing });
    expect(b.rect.w).toBeCloseTo(mockMeasure(d.font, d.letterSpacing, d.text), 9);
    // At the 1080-class size (refScale 1) the layout box is the drawn box.
    expect(b.drawn).toEqual(b.rect);
    // drawTitleCard anchors a centred line at its middle, a left one at its start.
    expect(card.align === 'center' ? b.rect.x + b.rect.w / 2 : b.rect.x).toBeCloseTo(d.x, 9);
    // The baseline sits 0.9 of the title size (1.0 of the subtitle size) below the slot's top.
    expect(b.rect.y + px * (part === 'title' ? 0.9 : 1.0)).toBeCloseTo(d.y, 9);
    expect(b.rect.h).toBeCloseTo(px * (part === 'title' ? 1.06 : 1.3), 9);
  });
}

describe('titleLineBoxes', () => {
  const rect = { x: 60, y: 900, w: 960, h: 620 };
  const texts = [
    { title: 'Golden title', subtitle: 'A handmade iPhone fixture' },
    // Long enough to wrap: two title lines and two subtitle lines.
    { title: 'A much longer headline that has to wrap', subtitle: 'and a subtitle long enough that it wraps onto a second line too' },
    { title: 'No subtitle' },
  ];
  for (const align of ['center', 'left'] as const) {
    for (const valign of ['top', 'center', 'bottom'] as const) {
      it(`puts every line where drawTitleCard drew it (align ${align}, valign ${valign})`, () => {
        for (const text of texts) {
          const { ctx, calls } = mockCanvas();
          const m = drawTitleCard(ctx, rect, text, { align, valign });
          const boxes = titleLineBoxes(rect, { ...m, align, valign }, mockMeasure);
          expect(boxes).toHaveLength(m.titleLines.length + m.subtitleLines.length);
          expectLinesMatch(boxes, fills(calls), { ...m, align });
          // The lines stack inside the card, top to bottom.
          for (let i = 1; i < boxes.length; i++) expect(boxes[i].rect.y).toBeGreaterThanOrEqual(boxes[i - 1].rect.y + boxes[i - 1].rect.h - 1e-9);
          expect(boxes[0].rect.y).toBeGreaterThanOrEqual(rect.y - 1e-9);
        }
        // The wrapping case really wrapped (so multi-line walks are covered).
        const m = drawTitleCard(mockCanvas().ctx, rect, texts[1], { align, valign });
        expect([m.titleLines.length, m.subtitleLines.length]).toEqual([2, 2]);
      });
    }
  }

  it('layoutRefScale: the canvas over its layout preset at its own size (2 at uhd4k, 1 at p1080 and without a preset)', () => {
    for (const presetId of ['social-9x16', 'landscape-16x9', 'feed-4x5']) {
      const p = phoneProject({ presetId });
      expect(layoutRefScale({ ...p, exportPreset: 'p1080' }, projectCanvasSize({ ...p, exportPreset: 'p1080' }).height)).toBe(1);
      expect(layoutRefScale({ ...p, exportPreset: 'uhd4k' }, projectCanvasSize({ ...p, exportPreset: 'uhd4k' }).height)).toBe(2);
    }
    expect(layoutRefScale(phoneProject({ presetId: 'none' }), 2622)).toBe(1);
  });

  it('splits only title cards that carry their layout; other boxes pass through', () => {
    const caption: TextBox = { kind: 'caption', rect: { x: 1, y: 2, w: 3, h: 4 } };
    const bare: TextBox = { kind: 'title', rect: { x: 0, y: 0, w: 10, h: 10 } };
    const card = { titlePx: 40, subtitlePx: 18, titleLines: ['Hi'], subtitleLines: [], blockHeight: 42.4, align: 'left' as const, valign: 'top' as const };
    expect(splitTitleCards([caption, bare, { kind: 'title', rect, card }], mockMeasure)).toEqual([
      caption,
      bare,
      { kind: 'title', text: 'Hi', rect: { x: rect.x, y: rect.y, w: 40, h: 40 * 1.06 }, drawn: { x: rect.x, y: rect.y, w: 40, h: 40 * 1.06 } },
    ]);
  });

  it("measures the layout width at the 1080-class size, so the font's optical sizing is not counted as layout; the drawn width is kept beside it", () => {
    // A font that draws tighter as it grows, like the system font's optical-size axis (flat from 80 px).
    const opsz: MeasureText = (font, _ls, text) => {
      const px = Number(font.match(/(\d+(?:\.\d+)?)px/)![1]);
      return text.length * px * (0.5 - 0.0005 * Math.min(80, px));
    };
    const card = { titlePx: 120, subtitlePx: 56, titleLines: ['Golden title'], subtitleLines: ['A handmade iPhone fixture'], blockHeight: 250, align: 'center' as const, valign: 'bottom' as const };
    const hd = titleLineBoxes(rect, card, opsz);
    const rect4k = { x: rect.x * 2, y: rect.y * 2, w: rect.w * 2, h: rect.h * 2 };
    const card4k = { ...card, titlePx: 240, subtitlePx: 112, blockHeight: 500 };
    const uhd = titleLineBoxes(rect4k, card4k, opsz, 2);
    // The layout box at 4K is exactly twice the 1080 one…
    uhd.forEach((b, i) => {
      for (const key of ['x', 'y', 'w', 'h'] as const) expect(b.rect[key]).toBeCloseTo(hd[i].rect[key] * 2, 9);
    });
    // …while the drawn subtitle (56 px → 112 px crosses the axis) is narrower than twice its 1080 width.
    expect(uhd[1].drawn!.w).toBeLessThan(hd[1].drawn!.w * 2 - 10);
    expect(uhd[1].drawn!.w).toBeCloseTo(opsz(titleLineFont('subtitle', 112).font, '', 'A handmade iPhone fixture'), 9);
    // A wrong font size at 4K still shows in the layout box.
    const wrong = titleLineBoxes(rect4k, { ...card4k, titlePx: 243 }, opsz, 2);
    expect(Math.abs(wrong[0].rect.w / 2 - hd[0].rect.w)).toBeGreaterThan(1);
    expect(Math.abs(wrong[0].rect.h / 2 - hd[0].rect.h)).toBeGreaterThan(1);
  });
});

describe("the compositor's title card box (CanvasCompositor.textBoxes)", () => {
  for (const name of ['ios-social', 'ios-16x9']) {
    it(`carries the layout it drew, so its lines match the compositor's own fillText calls (${name})`, async () => {
      const { project } = loadGoldenFixture(name);
      const h = await createHarness();
      try {
        const comp = h.compositor(project, projectCanvasSize(project));
        const rec = project.recording;
        const from = h.log.length;
        h.render(comp, 1, { frame: h.video('screen', rec.sourceSize.width, rec.sourceSize.height), cursor: null, ripples: [] });
        const title = comp.textBoxes.find((b) => b.kind === 'title');
        expect(title?.card).toBeDefined();
        const card = title!.card!;
        expect([...card.titleLines, ...card.subtitleLines].join(' ')).toBe(`${project.layout.titleCard!.title} ${project.layout.titleCard!.subtitle}`);
        const lines = titleLineBoxes(title!.rect, card, mockMeasure);
        // The harness log: canvas#0.fillText("text",x,y), after the font sets that drew it.
        let font = '';
        let letterSpacing = '';
        const drawn: Drawn[] = [];
        for (const l of h.log.slice(from)) {
          const f = l.match(/^canvas#0\.font = (".*")$/);
          if (f) font = JSON.parse(f[1]);
          const s = l.match(/^canvas#0\.letterSpacing = (".*")$/);
          if (s) letterSpacing = JSON.parse(s[1]);
          const t = l.match(/^canvas#0\.fillText\((".*"),([^,]+),([^,]+)\)$/);
          if (t && lines.some((b) => b.text === JSON.parse(t[1]))) drawn.push({ text: JSON.parse(t[1]), x: Number(t[2]), y: Number(t[3]), font, letterSpacing });
        }
        expectLinesMatch(lines, drawn, card);
      } finally {
        h.dispose();
      }
    });
  }
});
