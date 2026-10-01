/** Where the app is, so the native menu can enable only what applies. */
export type MenuPhase = 'picker' | 'recording' | 'editor';

export type MenuAction =
  | 'newRecording'
  | 'openProject'
  | 'save'
  | 'exportMp4'
  | 'exportGif'
  | 'undo'
  | 'redo'
  | 'playPause'
  | 'split';

/** One row of a right-click menu built by the renderer and shown natively. */
export type ContextMenuItem =
  | { type?: 'item'; id: string; label: string; enabled?: boolean }
  | { type: 'separator' };

/** True when keyboard focus is in something that edits text, where undo/redo
 *  and typed keys belong to the field rather than the editor. */
export function isEditableTarget(el: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
