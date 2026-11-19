import { WebContentsView, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { floatingBounds, nearestDock, normalizeDock } from './floating-position.mjs';

/** The floating menu belongs to the workbench; the setup page at `setupUrl` already offers everything it does. */
export async function createShellControls(window, actions, setupUrl) {
  const url = new URL('../ui/shell.html', import.meta.url).href;
  const view = new WebContentsView({ webPreferences: {
    preload: fileURLToPath(new URL('./shell-preload.cjs', import.meta.url)),
    contextIsolation: true, nodeIntegration: false, sandbox: true,
  } });
  let expanded = false;
  let disposed = false;
  let position = normalizeDock();
  let dragging;
  let placement;
  view.setBackgroundColor('#00000000');
  window.contentView.addChildView(view);
  const layout = () => {
    if (disposed || window.isDestroyed()) return;
    const page = window.webContents.getURL();
    view.setVisible(!!page && page !== setupUrl);
    const [width, height] = window.getContentSize();
    placement = floatingBounds(position, width, height, expanded, dragging?.center);
    view.setBounds(placement.bounds);
    update();
  };
  const update = () => {
    if (!disposed && !view.webContents.isDestroyed()) view.webContents.send('shell:state', { canWorkbench: actions.canWorkbench(), canTray: actions.canTray(), placement });
  };
  ipcMain.handle('desktop:shell', async (event, name, input) => {
    if (disposed || event.sender !== view.webContents || event.senderFrame !== view.webContents.mainFrame || event.senderFrame.url !== url) throw new Error('操作来源无效');
    if (name === 'expanded') { expanded = input === true; layout(); return; }
    if (name === 'state') return { canWorkbench: actions.canWorkbench(), canTray: actions.canTray(), placement };
    if (name === 'dragStart' || name === 'dragMove') {
      if (!Number.isFinite(input?.x) || !Number.isFinite(input?.y)) throw new Error('拖动位置无效');
      const content = window.getContentBounds();
      if (name === 'dragStart') {
        const center = { x: placement.bounds.x + placement.triggerX + 24, y: placement.bounds.y + placement.triggerY + 24 };
        dragging = { offset: { x: input.x - content.x - center.x, y: input.y - content.y - center.y }, center };
        expanded = false;
      }
      if (!dragging) throw new Error('拖动尚未开始');
      dragging.center = { x: input.x - content.x - dragging.offset.x, y: input.y - content.y - dragging.offset.y };
      layout(); return;
    }
    if (name === 'dragEnd') {
      if (!dragging) return;
      const [width, height] = window.getContentSize();
      position = nearestDock(dragging.center, width, height);
      dragging = undefined;
      layout();
      await actions.savePosition(position);
      return;
    }
    if (!['setup', 'workbench', 'tray', 'quit', 'zoomIn', 'zoomOut', 'zoomReset'].includes(name)) throw new Error('操作来源无效');
    await actions[name]();
  });
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  view.webContents.on('will-navigate', (event, target) => { if (target !== url) event.preventDefault(); });
  const collapse = () => {
    if (disposed || dragging) return;
    expanded = false; layout();
    view.webContents.send('shell:collapse');
  };
  window.on('resize', layout);
  const navigated = () => { dragging = undefined; collapse(); };
  window.webContents.on('did-navigate', navigated);
  window.webContents.on('focus', collapse);
  const outsideClick = (_event, input) => { if (input.type === 'mouseDown') collapse(); };
  window.webContents.on('before-mouse-event', outsideClick);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    ipcMain.removeHandler('desktop:shell');
    window.off('resize', layout);
    window.webContents.off('did-navigate', navigated);
    window.webContents.off('focus', collapse);
    window.webContents.off('before-mouse-event', outsideClick);
    if (!window.isDestroyed()) window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
  };
  window.once('closed', dispose);
  layout();
  try { await view.webContents.loadURL(url); update(); }
  catch (error) { dispose(); throw error; }
  return { update, dispose, restorePosition(value) { position = normalizeDock(value); layout(); } };
}
