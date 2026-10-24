// The text the compositor drew at its last render, as layout boxes in canvas
// px (CanvasCompositor.textBoxes): caption pills, keystroke keycaps, text
// overlays and the title card, in the order they were drawn. `frames`
// reports them per still (HeadlessFrame.textBoxes), so the 4K-downscale
// check (scripts/golden/downscale4k.mjs, SPEC §4.2 and owner decision 8)
// can mask text out of its picture comparison and check the text layout on
// its own. Pure data; no DOM.
//
// The title card is the one box whose text is laid out inside it (its font
// size and line breaks are picked to fit): the compositor reports the card's
// area plus the layout drawTitleCard returned (`card`), and `frames` turns
// that into one box per drawn line (renderer/src/titleLineBoxes.ts), so the
// check compares the real lines, not their container.

export type TextBoxKind = 'caption' | 'keycap' | 'annotation' | 'title';

export interface TitleCardLayout {
  /** As drawTitleCard returned it (mobile/layout TitleCardMetrics). */
  titlePx: number;
  subtitlePx: number;
  titleLines: string[];
  subtitleLines: string[];
  blockHeight: number;
  /** The style the compositor drew it with. */
  align: 'center' | 'left';
  valign: 'top' | 'center' | 'bottom';
}

export interface TextBox {
  kind: TextBoxKind;
  /** The box the text is laid out in, canvas px (a caption's or keycap's pill; an overlay's text line; the title card's area, or one drawn title line). */
  rect: { x: number; y: number; w: number; h: number };
  /** A title line's text ('title' boxes from `frames`). */
  text?: string;
  /** A title line as measured at the size it was drawn; `rect` is measured at its 1080-class size (renderer/src/titleLineBoxes.ts). */
  drawn?: { x: number; y: number; w: number; h: number };
  /** The title card's layout (the compositor's 'title' box, before `frames` splits it into lines). */
  card?: TitleCardLayout;
}

/**
 * `boxes` with x and widths times `kx`, y and heights times `ky` (canvas px →
 * PNG px for a scaled still). A title card's `card` is in canvas px, so it is
 * dropped: split the card into lines first (titleLineBoxes).
 */
export function scaleTextBoxes(boxes: readonly TextBox[], kx: number, ky = kx): TextBox[] {
  const scale = (r: TextBox['rect']) => ({ x: r.x * kx, y: r.y * ky, w: r.w * kx, h: r.h * ky });
  return boxes.map(({ kind, rect, text, drawn }) => ({
    kind,
    rect: scale(rect),
    ...(text !== undefined ? { text } : {}),
    ...(drawn ? { drawn: scale(drawn) } : {}),
  }));
}
