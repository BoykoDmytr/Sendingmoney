// Preload (sandbox-safe CommonJS). The ONLY bridge between the sandboxed
// renderer and the main process. Exposes a small, explicit API surface — no raw
// ipcRenderer, no Node, no key ever flows back out.
const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (res && res.ok) return res.data;
  throw new Error(res && res.error ? res.error : 'Unknown error');
}

contextBridge.exposeInMainWorld('api', {
  // configuration / wallet
  configure: (input) => invoke('engine:configure', input),
  unlock: (privateKey) => invoke('engine:unlock', privateKey),
  lock: () => invoke('engine:lock'),
  isUnlocked: () => invoke('engine:isUnlocked'),

  // chain / file / plan
  connect: () => invoke('engine:connect'),
  chooseFile: () => invoke('dialog:openFile'),
  validate: (filePath) => invoke('engine:validate', filePath),
  prepare: (opts) => invoke('engine:prepare', opts),
  preflight: () => invoke('engine:preflight'),

  // run control
  run: (opts) => invoke('engine:run', opts),
  stop: () => invoke('engine:stop'),
  results: () => invoke('engine:results'),

  // shell helpers
  openExternal: (url) => invoke('shell:openExternal', url),
  showItem: (p) => invoke('shell:showItem', p),

  // live progress stream (main -> renderer). Returns an unsubscribe function.
  onProgress: (cb) => {
    const listener = (_e, data) => { try { cb(data); } catch { /* a UI handler throw must not break the stream */ } };
    ipcRenderer.on('engine:progress', listener);
    return () => ipcRenderer.removeListener('engine:progress', listener);
  },
});
