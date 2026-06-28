// Electron main process (CommonJS). Owns the single PayoutEngine instance and
// therefore the private key — which lives only here, in main-process memory,
// and is never sent back to the renderer, logged or persisted.
//
// Security posture: the renderer runs sandboxed with context isolation and no
// Node integration; it can only reach main through the whitelisted ipcMain
// channels below (via preload's contextBridge). Navigation and popups are
// locked down.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let win = null;
let engine = null; // PayoutEngine (ESM) loaded lazily

// Resolve writable locations: keep the ledger + logs + results under userData so
// a packaged (read-only) install still works.
function paths() {
  const base = app.getPath('userData');
  return {
    dataPath: path.join(base, 'data', 'payouts.sqlite'),
    resultsDir: path.join(base, 'results'),
    logsDir: path.join(base, 'logs'),
  };
}

async function getEngine() {
  if (engine) return engine;
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'engine.js')).href);
  const p = paths();
  // All writable artifacts (ledger DB, per-run logs, results.xlsx) live under
  // userData with absolute paths, so a packaged (read-only) install still works.
  engine = new mod.PayoutEngine({ dataPath: p.dataPath, resultsDir: p.resultsDir, logsDir: p.logsDir });
  return engine;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    title: 'USDT Batch Payout (BSC)',
    backgroundColor: '#0f1419',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // Lock down navigation + popups (defence in depth).
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// --- IPC: every channel is an explicit whitelist entry --------------------

function wrap(handler) {
  // Normalize errors to plain messages (never leak objects that could contain
  // sensitive context) and never let the key surface in an error.
  return async (_evt, ...args) => {
    try {
      return { ok: true, data: await handler(...args) };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  };
}

function registerIpc() {
  ipcMain.handle('engine:configure', wrap(async (input) => (await getEngine()).configure(input || {})));
  ipcMain.handle('engine:unlock', wrap(async (privateKey) => (await getEngine()).unlock(privateKey)));
  ipcMain.handle('engine:lock', wrap(async () => (await getEngine()).lock()));
  ipcMain.handle('engine:isUnlocked', wrap(async () => ({ unlocked: (await getEngine()).isUnlocked() })));
  ipcMain.handle('engine:connect', wrap(async () => (await getEngine()).connect()));
  ipcMain.handle('engine:validate', wrap(async (filePath) => (await getEngine()).validate(filePath)));
  ipcMain.handle('engine:prepare', wrap(async (opts) => (await getEngine()).prepare(opts)));
  ipcMain.handle('engine:preflight', wrap(async () => (await getEngine()).preflight()));
  ipcMain.handle('engine:stop', wrap(async () => (await getEngine()).stop()));
  ipcMain.handle('engine:results', wrap(async () => (await getEngine()).resultRows()));

  ipcMain.handle('engine:run', wrap(async (opts) => {
    const eng = await getEngine();
    const send = (e) => { if (win && !win.isDestroyed()) win.webContents.send('engine:progress', e); };
    return eng.run({ onEvent: send, stopOnError: Boolean(opts && opts.stopOnError), confirm: opts && opts.confirm });
  }));

  ipcMain.handle('dialog:openFile', wrap(async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Select payouts spreadsheet',
      properties: ['openFile'],
      filters: [{ name: 'Spreadsheets', extensions: ['xlsx', 'xls'] }],
    });
    return { filePath: res.canceled || !res.filePaths.length ? null : res.filePaths[0] };
  }));

  ipcMain.handle('shell:openExternal', wrap(async (url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { opened: false };
    // Only open links on the configured explorer origin (links are always built
    // from cfg.explorerUrl). Falls back to allowing https before any config.
    let allowed = true;
    try {
      const explorer = engine && engine.cfg && engine.cfg.explorerUrl;
      if (explorer) allowed = new URL(url).origin === new URL(explorer).origin;
    } catch { allowed = false; }
    if (allowed) await shell.openExternal(url);
    return { opened: allowed };
  }));
  ipcMain.handle('shell:showItem', wrap(async (p) => {
    if (typeof p === 'string' && p) shell.showItemInFolder(path.resolve(p));
    return { shown: true };
  }));
}

// Single instance.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    // Minimal menu: keep clipboard shortcuts, drop the rest.
    const isMac = process.platform === 'darwin';
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]));
    registerIpc();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('window-all-closed', async () => {
  try { await engine?.dispose(); } catch { /* ignore */ }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  try { await engine?.dispose(); } catch { /* ignore */ }
});
