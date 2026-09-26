import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import type { MenuAction, MenuPhase } from '../shared/menu';

/** The native macOS menu. Items that act on the app send a `menu:action` to
 *  the renderer, which routes it to the existing handler for that action. */
export function buildAppMenu(
  win: () => BrowserWindow | null,
  state: { phase: MenuPhase; bundleDir?: string },
): Menu {
  const send = (action: MenuAction) => () => win()?.webContents.send('menu:action', action);
  const sendOrOpen = (action: MenuAction) => () => {
    const w = win();
    if (w) w.webContents.send('menu:action', action);
    else app.emit('activate');
  };
  const inEditor = state.phase === 'editor';
  const idle = state.phase !== 'recording';

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Recording', accelerator: 'CmdOrCtrl+N', enabled: idle, click: sendOrOpen('newRecording') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', enabled: idle, click: sendOrOpen('openProject') },
        { type: 'separator' },
        { label: 'Save Project', accelerator: 'CmdOrCtrl+S', enabled: inEditor, click: send('save') },
        { label: 'Export MP4…', accelerator: 'CmdOrCtrl+E', enabled: inEditor, click: send('exportMp4') },
        { label: 'Export GIF…', accelerator: 'Shift+CmdOrCtrl+E', enabled: inEditor, click: send('exportGif') },
        { type: 'separator' },
        {
          label: 'Show Project in Finder',
          enabled: inEditor && !!state.bundleDir,
          click: () => state.bundleDir && shell.showItemInFolder(state.bundleDir),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // Undo/redo go through the renderer: text fields get the native
        // command, everything else gets the editor's project history.
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: send('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Playback',
      submenu: [
        // Shown for discoverability only; the editor's own key handler owns
        // these so typing a space or "s" in a text field still works.
        { label: 'Play / Pause', accelerator: 'Space', registerAccelerator: false, enabled: inEditor, click: send('playPause') },
        { label: 'Split at Playhead', accelerator: 'S', registerAccelerator: false, enabled: inEditor, click: send('split') },
      ],
    },
    {
      label: 'View',
      submenu: [
        ...(!app.isPackaged
          ? ([{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }] as MenuItemConstructorOptions[])
          : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'OpenScreen on GitHub', click: () => void shell.openExternal('https://github.com/tszaks/openscreen') },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
