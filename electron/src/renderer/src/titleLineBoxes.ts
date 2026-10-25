// The title card as the lines it drew. The compositor reports the card's
// area plus the layout drawTitleCard returned (TextBox.card); this turns
// that into one box per drawn title or subtitle line, so the 4K-downscale
// check (owner decision 8) compares where each line really is and how big it
// is, and masks only the lines, not the whole card.
//
// It walks the baselines exactly as mobile/layout.ts drawTitleCard does
// (title: 0.9 px above the baseline + 0.16 px below; then 0.32 px of the
// title size; subtitle: 1.0 px above + 0.3 px below), with the same fonts and
// tracking. A line's box is its slot on that walk: x and width from the
// measured text (centred on the card the way drawTitleCard centres it),
// y and height from the walk. test/titleLineBoxes.test.ts checks every
// number against drawTitleCard's own fillText calls, so a change to how the
// card draws fails there.
//
// Two widths per line. The macOS system font has an optical-size axis: at a
// larger size its glyphs are drawn a little tighter (measured on the
// ios-social subtitle: 1.1% narrower at 114 px than twice its width at
// 57 px). That is font rendering, which owner decision 8 keeps out of the
// check. So `rect` measures the line at the size the layout gives it at the
// 1080-class canvas (the drawn size divided by `refScale`, the canvas's
// scale over its layout preset's own size) and scales that back up: it
// moves only with the layout's own choices (font size, line breaks,
// tracking, position). `drawn` is the line measured at the size it was
// really drawn, for the mask and for the record.

import { defaultTitleCardStyle, titleTracking } from './mobile/layout';
import { layoutPreset } from '../../shared/mobileProject';
import type { TextBox, TitleCardLayout } from '../../shared/textBoxes';
import type { Project } from '../../shared/types';

/** Subtitle tracking, as mobile/layout.ts sets it (-0.4% of the size). */
const subtitleTracking = (px: number) => -0.004 * px;

/** The width `text` takes in `font` with `letterSpacing` (a CSS length), canvas px. */
export type MeasureText = (font: string, letterSpacing: string, text: string) => number;

/** The font and letterSpacing drawTitleCard sets for a line (mobile/layout setFont). */
export function titleLineFont(part: 'title' | 'subtitle', px: number): { font: string; letterSpacing: string } {
  const weight = part === 'title' ? defaultTitleCardStyle.weight : 500;
  const tracking = part === 'title' ? titleTracking(px) : subtitleTracking(px);
  return { font: `${weight} ${px}px ${defaultTitleCardStyle.fontFamily}`, letterSpacing: `${tracking.toFixed(2)}px` };
}

/**
 * One 'title' box per line drawTitleCard drew in `rect` with `card`, top to
 * bottom, canvas px. `refScale` = this canvas over the 1080-class canvas of
 * its layout preset (2 at uhd4k, 1 at the preset's own size).
 */
export function titleLineBoxes(rect: TextBox['rect'], card: TitleCardLayout, measure: MeasureText, refScale = 1): TextBox[] {
  const { titlePx: tp, subtitlePx: sp, align, valign } = card;
  let y = valign === 'top' ? rect.y : valign === 'bottom' ? rect.y + rect.h - card.blockHeight : rect.y + (rect.h - card.blockHeight) / 2;
  const anchor = align === 'center' ? rect.x + rect.w / 2 : rect.x;
  const boxes: TextBox[] = [];
  const width = (part: 'title' | 'subtitle', px: number, text: string) => {
    const { font, letterSpacing } = titleLineFont(part, px);
    return measure(font, letterSpacing, text);
  };
  const line = (part: 'title' | 'subtitle', px: number, text: string, top: number, h: number, nudge: number) => {
    const at = (w: number) => ({ x: align === 'center' ? anchor + nudge - w / 2 : anchor + nudge, y: top, w, h });
    const drawnW = width(part, px, text);
    const layoutW = refScale === 1 ? drawnW : width(part, px / refScale, text) * refScale;
    boxes.push({ kind: 'title', text, rect: at(layoutW), drawn: at(drawnW) });
  };
  for (const text of card.titleLines) {
    // drawTitleCard: baseline px·0.9 down, then px·0.16 of line gap.
    line('title', tp, text, y, tp * 1.06, align === 'center' ? -titleTracking(tp) / 2 : 0);
    y += tp * 1.06;
  }
  if (card.subtitleLines.length) {
    y += tp * 0.32;
    for (const text of card.subtitleLines) {
      line('subtitle', sp, text, y, sp * 1.3, 0);
      y += sp * 1.3;
    }
  }
  return boxes;
}

/** A canvas `canvasHeight` px tall over its layout preset's own (1080-class) canvas: 2 at uhd4k; 1 without a preset. */
export function layoutRefScale(project: Project, canvasHeight: number): number {
  const preset = layoutPreset({ ...project, exportPreset: undefined });
  return preset ? canvasHeight / preset.height : 1;
}

/** `boxes` with every title card split into its drawn lines (titleLineBoxes); other boxes unchanged. */
export function splitTitleCards(boxes: readonly TextBox[], measure: MeasureText, refScale = 1): TextBox[] {
  return boxes.flatMap((b) => (b.kind === 'title' && b.card ? titleLineBoxes(b.rect, b.card, measure, refScale) : [b]));
}
