// The text the compositor drew at its last render, as layout boxes in canvas
// px (CanvasCompositor.textBoxes): caption pills, keystroke keycaps, text
// overlays and the title card, in the order they were drawn. `frames`
// reports them per still (HeadlessFrame.textBoxes), so the 4K-downscale
// check (scripts/golden/downscale4k.mjs, SPEC §4.2 and owner decision 8)
// can mask text out of its picture comparison and check the text layout on
// its own. Pure data; no DOM.

export type TextBoxKind = 'caption' | 'keycap' | 'annotation' | 'title';

export interface TextBox {
  kind: TextBoxKind;
  /** The box the text is laid out in, canvas px (a caption's or keycap's pill; an overlay's text line; the title card's area). */
  rect: { x: number; y: number; w: number; h: number };
}

/** `boxes` with x and widths times `kx`, y and heights times `ky` (canvas px → PNG px for a scaled still). */
export function scaleTextBoxes(boxes: readonly TextBox[], kx: number, ky = kx): TextBox[] {
  return boxes.map(({ kind, rect: r }) => ({ kind, rect: { x: r.x * kx, y: r.y * ky, w: r.w * kx, h: r.h * ky } }));
}
