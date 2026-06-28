'use strict';
// Renderer logic. No Node, no network — everything goes through window.api
// (the preload bridge). All dynamic text uses textContent (never innerHTML with
// data) to avoid any injection from file/chain content.
//
// Wrapped in an IIFE so none of these top-level bindings leak into the global
// lexical scope.
(() => {

const $ = (id) => document.getElementById(id);
const api = window.api;

const state = {
  configured: false,
  unlocked: false,
  connected: false,
  decimals: null,
  symbol: null,
  filePath: null,
  validationOk: false,
  hasDuplicates: false,
  prepared: null, // { mode, runId, plan[], count }
  preflightOk: false,
  running: false,
};

// ---- helpers --------------------------------------------------------------

function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 4200);
}

function setHint(id, msg, kind = '') {
  const e = $(id);
  if (!e) return;
  e.textContent = msg || '';
  e.className = 'hint' + (kind ? ' ' + kind : '');
}

function short(addr) {
  return addr && addr.length > 14 ? addr.slice(0, 8) + '…' + addr.slice(-6) : addr;
}

function badge(status, label) {
  const s = document.createElement('span');
  s.className = 'badge ' + status;
  s.textContent = label || status;
  return s;
}

function txLink(url, text) {
  const a = document.createElement('span');
  a.className = 'link';
  a.textContent = text;
  a.title = url;
  a.addEventListener('click', () => api.openExternal(url).catch(() => {}));
  return a;
}

async function call(fn, { busyBtn, hintId, okMsg } = {}) {
  if (busyBtn) busyBtn.disabled = true;
  try {
    const data = await fn();
    if (okMsg && hintId) setHint(hintId, okMsg, 'ok');
    return data;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (hintId) setHint(hintId, msg, 'bad');
    toast(msg, 'bad');
    throw err;
  } finally {
    if (busyBtn) busyBtn.disabled = false;
    refreshGating();
  }
}

function refreshPills() {
  const pc = $('pillConfig'); pc.textContent = 'Settings: ' + (state.configured ? 'applied' : '—'); pc.className = 'pill' + (state.configured ? ' ok' : '');
  const pw = $('pillWallet'); pw.textContent = 'Wallet: ' + (state.unlocked ? 'unlocked' : 'locked'); pw.className = 'pill' + (state.unlocked ? ' ok' : '');
  const pch = $('pillChain'); pch.textContent = 'Chain: ' + (state.connected ? (state.chainId || '56') : '—'); pch.className = 'pill' + (state.connected ? ' ok' : '');
  const pt = $('pillToken'); pt.textContent = 'Token: ' + (state.symbol ? `${state.symbol}/${state.decimals}` : '—'); pt.className = 'pill' + (state.connected ? ' ok' : '');
}

function refreshGating() {
  $('btnLock').disabled = !state.unlocked;
  $('btnConnect').disabled = !state.configured;
  $('btnValidate').disabled = !(state.filePath && state.connected);
  $('btnPrepare').disabled = !(state.validationOk);
  $('btnPreflight').disabled = !state.prepared;
  const mode = currentMode();
  $('btnStart').disabled = !(state.preflightOk && mode !== 'dry-run' && state.unlocked && !state.running);
  $('btnStop').disabled = !state.running;
  refreshPills();
}

function currentMode() {
  const r = document.querySelector('input[name="mode"]:checked');
  return r ? r.value : 'dry-run';
}

// Any change to mode / settings / file makes a previously prepared plan and its
// pre-flight stale — clear them so the user must re-Prepare (prevents the engine
// from sending an execute plan while the UI shows "test", etc.).
function invalidatePlan() {
  state.prepared = null;
  state.preflightOk = false;
  for (const id of ['planSummary', 'preflightResult', 'preflightProblems', 'runTable', 'runSummary', 'progressWrap', 'runArtifacts']) {
    const e = $(id); if (e) e.hidden = true;
  }
}

function readSettings() {
  return {
    rpcUrl: $('rpcUrl').value.trim(),
    rpcFallbacks: $('rpcFallbacks').value.trim(),
    tokenAddress: $('tokenAddress').value.trim(),
    chainId: $('chainId').value.trim(),
    explorerUrl: $('explorerUrl').value.trim(),
    testAmount: $('testAmount').value.trim(),
    expectedSymbol: $('expectedSymbol').value.trim(),
    expectedDecimals: $('expectedDecimals').value.trim(),
    maxRetries: $('maxRetries').value.trim(),
    gasLimitPerTx: $('gasLimitPerTx').value.trim(),
    gasPriceMultiplier: $('gasPriceMultiplier').value.trim(),
  };
}

// ---- 1. settings ----------------------------------------------------------

$('btnApply').addEventListener('click', async () => {
  await call(() => api.configure(readSettings()), { busyBtn: $('btnApply'), hintId: 'settingsHint', okMsg: 'Settings applied.' });
  state.configured = true;
  state.connected = false; state.symbol = null; state.decimals = null;
  invalidatePlan();
  refreshGating();
});

// ---- 2. wallet ------------------------------------------------------------

$('btnUnlock').addEventListener('click', async () => {
  const key = $('privateKey').value.trim();
  if (!key) { toast('Enter a private key first.', 'bad'); return; }
  try {
    const { address } = await call(() => api.unlock(key), { busyBtn: $('btnUnlock') });
    state.unlocked = true;
    $('walletAddr').textContent = address;
    $('walletInfo').hidden = false;
    state.chainId = $('chainId').value.trim();
    toast('Wallet unlocked (key kept only in memory).', 'ok');
  } catch { /* hint shown */ } finally {
    $('privateKey').value = ''; // wipe from the DOM regardless of success/failure
  }
  refreshGating();
});

$('btnLock').addEventListener('click', async () => {
  await call(() => api.lock(), { busyBtn: $('btnLock') });
  state.unlocked = false;
  $('walletInfo').hidden = true;
  toast('Wallet locked, key wiped.', 'ok');
  refreshGating();
});

// ---- 3. connect -----------------------------------------------------------

$('btnConnect').addEventListener('click', async () => {
  const r = await call(() => api.connect(), { busyBtn: $('btnConnect'), hintId: 'connectHint' });
  state.connected = true;
  state.symbol = r.symbol; state.decimals = r.decimals; state.chainId = r.chainId;
  const box = $('connectResult');
  box.hidden = false;
  box.innerHTML = '';
  const add = (k, v, cls) => {
    const kk = document.createElement('div'); kk.className = 'k'; kk.textContent = k;
    const vv = document.createElement('div'); vv.className = 'v' + (cls ? ' ' + cls : ''); vv.textContent = v;
    box.append(kk, vv);
  };
  add('Guard', r.ok ? 'OK — token matches expected' : ('REFUSED — ' + r.reason), r.ok ? 'ok' : 'bad');
  add('Symbol / decimals', `${r.symbol} / ${r.decimals}`);
  add('Token', r.tokenAddress);
  add('RPC', r.rpc);
  if (r.walletAddress) add('Wallet', r.walletAddress);
  if (r.usdtBalance != null) add(`${r.symbol} balance`, r.usdtBalance);
  if (r.bnbBalance != null) add('BNB balance', r.bnbBalance);
  setHint('connectHint', r.ok ? 'Connected.' : 'Token guard refused — check the token address.', r.ok ? 'ok' : 'bad');
  if (!r.ok) state.connected = false;
  // Decimals may have changed — force re-validation and a fresh plan.
  state.validationOk = false;
  invalidatePlan();
  refreshGating();
});

// ---- 4. file + validation -------------------------------------------------

$('btnChoose').addEventListener('click', async () => {
  const { filePath } = await call(() => api.chooseFile(), { busyBtn: $('btnChoose') });
  if (filePath) {
    state.filePath = filePath;
    $('filePath').textContent = filePath;
    state.validationOk = false;
    invalidatePlan();
  }
  refreshGating();
});

$('btnValidate').addEventListener('click', async () => {
  const v = await call(() => api.validate(state.filePath), { busyBtn: $('btnValidate') });
  invalidatePlan(); // a re-validate means any prior plan is stale
  const sum = $('validationSummary');
  sum.hidden = false; sum.innerHTML = '';
  const addLine = (txt) => { const d = document.createElement('div'); d.textContent = txt; sum.appendChild(d); };
  // Which sheet/columns were auto-detected.
  addLine(`Sheet "${v.sheetName}" · address column: "${v.addrHeader}" · amount column: "${v.amtHeader}".`);
  addLine(`${v.recipients.length} valid recipient(s), ${v.errors.length} error(s). Total: ${v.totalHuman} ${v.symbol}.`);
  // Ignored non-recipient rows (totals / section labels).
  if (v.ignored && v.ignored.length) {
    addLine(`ⓘ Ignored ${v.ignored.length} non-recipient row(s) (e.g. totals): ${v.ignored.map((x) => `row ${x.row} "${x.value}"`).join(', ')}.`);
  }

  // duplicates
  state.hasDuplicates = v.duplicates.length > 0;
  $('dupBox').hidden = !state.hasDuplicates;
  if (state.hasDuplicates) {
    $('dupText').textContent = `⚠️ ${v.duplicates.length} duplicate address(es) found (${v.duplicates.map((d) => short(d.address)).join(', ')}).`;
  }

  renderRecipients(v);
  state.validationOk = v.errors.length === 0 && v.recipients.length > 0;
  if (!state.validationOk) {
    setHint('prepareHint', 'Fix the invalid rows before preparing.', 'bad');
    toast(`${v.errors.length} invalid row(s) — nothing can be sent until fixed.`, 'bad');
  } else {
    toast('Validation passed.', 'ok');
  }
  refreshGating();
});

function renderRecipients(v) {
  const t = $('recipientsTable');
  t.hidden = false;
  const thead = t.querySelector('thead'); const tbody = t.querySelector('tbody');
  thead.innerHTML = ''; tbody.innerHTML = '';
  if (v.errors.length > 0) {
    thead.appendChild(rowEl(['Row', 'Address', 'Amount', 'Problem'], true));
    for (const e of v.errors) {
      const tr = rowEl([String(e.row), e.address || '(empty)', e.amount || '(empty)', e.reason]);
      tr.className = 'bad';
      tbody.appendChild(tr);
    }
  } else {
    thead.appendChild(rowEl(['#', 'Address', 'Amount'], true));
    v.recipients.forEach((r, i) => tbody.appendChild(rowEl([String(i + 1), r.address, `${r.human} ${v.symbol}`])));
  }
}

function rowEl(cells, header = false) {
  const tr = document.createElement('tr');
  for (const c of cells) {
    const td = document.createElement(header ? 'th' : 'td');
    td.textContent = c;
    tr.appendChild(td);
  }
  return tr;
}

// ---- 5. prepare -----------------------------------------------------------

document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', () => { invalidatePlan(); refreshGating(); }));

$('btnPrepare').addEventListener('click', async () => {
  const mode = currentMode();
  const duplicatePolicy = $('dupPolicy').value;
  const p = await call(() => api.prepare({ filePath: state.filePath, mode, duplicatePolicy }), { busyBtn: $('btnPrepare'), hintId: 'prepareHint' });
  state.prepared = p; state.preflightOk = false;
  const sum = $('planSummary'); sum.hidden = false; sum.innerHTML = '';
  const add = (txt, big) => { const d = document.createElement('div'); if (big) d.className = 'big'; d.textContent = txt; sum.appendChild(d); };
  add(`Mode: ${p.mode}   ·   run id: ${p.runId}`);
  add(`${p.count} recipient(s)`, false);
  add(`Total (all): ${p.totalAllHuman} ${p.symbol}`, true);
  add(`Remaining to send now: ${p.totalPendingHuman} ${p.symbol}` + (p.alreadyPaid ? `  (${p.alreadyPaid} already paid — will skip)` : ''));
  if (p.duplicatesMerged) add('Duplicates were summed into single recipients.');
  setHint('prepareHint', 'Plan ready. Run pre-flight next.', 'ok');
  refreshGating();
});

// ---- 6. pre-flight --------------------------------------------------------

$('btnPreflight').addEventListener('click', async () => {
  const pf = await call(() => api.preflight(), { busyBtn: $('btnPreflight'), hintId: 'preflightHint' });
  const box = $('preflightResult'); box.hidden = false; box.innerHTML = '';
  const add = (k, v, cls) => {
    const kk = document.createElement('div'); kk.className = 'k'; kk.textContent = k;
    const vv = document.createElement('div'); vv.className = 'v' + (cls ? ' ' + cls : ''); vv.textContent = v;
    box.append(kk, vv);
  };
  add('Pending', `${pf.pendingCount}`);
  add('Total to send', `${pf.totalPendingHuman} ${pf.symbol}`);
  if (pf.wallet) add('Wallet', pf.wallet);
  if (pf.usdtBalanceHuman != null) add(`${pf.symbol} balance`, pf.usdtBalanceHuman, pf.ok ? 'ok' : 'bad');
  if (pf.bnbBalanceHuman != null) add('BNB balance', pf.bnbBalanceHuman);
  add('Gas price', `${pf.gasPriceGwei} gwei`);
  add('Gas budget (max)', `~${pf.gasBudgetMaxBnb} BNB`);

  const prob = $('preflightProblems');
  if (pf.ok) {
    prob.hidden = true; prob.innerHTML = '';
    state.preflightOk = true;
    setHint('preflightHint', 'Pre-flight passed.', 'ok');
  } else {
    prob.hidden = false; prob.innerHTML = '';
    const h = document.createElement('div'); h.textContent = 'Pre-flight failed — cannot send:'; prob.appendChild(h);
    const ul = document.createElement('ul');
    pf.problems.forEach((p) => { const li = document.createElement('li'); li.textContent = p; ul.appendChild(li); });
    prob.appendChild(ul);
    state.preflightOk = false;
    setHint('preflightHint', 'Resolve the problems above.', 'bad');
  }
  refreshGating();
});

// ---- 7. run ---------------------------------------------------------------

const modal = $('confirmModal');
$('confirmInput').addEventListener('input', (e) => { $('btnConfirmGo').disabled = e.target.value !== 'YES'; });
$('btnConfirmCancel').addEventListener('click', () => { modal.hidden = true; $('confirmInput').value = ''; $('btnConfirmGo').disabled = true; });

$('btnStart').addEventListener('click', () => {
  const mode = currentMode();
  if (mode === 'dry-run') { toast('Dry-run sends nothing. Pick Test or Execute.', 'bad'); return; }
  const p = state.prepared;
  $('confirmTitle').textContent = mode === 'test' ? 'Confirm TEST send' : 'Confirm REAL payout';
  $('confirmText').textContent =
    `About to send to ${p.count} recipient(s) for a total of ${p.totalPendingHuman} ${p.symbol} on chain ${state.chainId} (mode: ${mode}). This moves real funds.`;
  $('confirmInput').value = ''; $('btnConfirmGo').disabled = true; modal.hidden = false;
  $('confirmInput').focus();
});

$('btnConfirmGo').addEventListener('click', async () => {
  modal.hidden = true; $('confirmInput').value = ''; $('btnConfirmGo').disabled = true;
  await doRun();
});

let unsubscribe = null;

async function doRun() {
  state.running = true;
  refreshGating();
  buildRunTable();
  $('progressWrap').hidden = false;
  $('runSummary').hidden = true;
  $('runArtifacts').hidden = true;

  if (unsubscribe) unsubscribe();
  unsubscribe = api.onProgress(handleProgress);

  try {
    // The user has already typed YES in the confirm modal to reach here.
    const res = await api.run({ stopOnError: $('stopOnError').checked, confirm: 'YES' });
    showRunSummary(res);
  } catch (err) {
    toast(err.message || String(err), 'bad');
  } finally {
    state.running = false;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    refreshGating();
  }
}

$('btnStop').addEventListener('click', async () => {
  $('btnStop').disabled = true;
  await api.stop().catch(() => {});
  toast('Stopping after the current transaction…');
});

function buildRunTable() {
  const t = $('runTable'); t.hidden = false;
  const thead = t.querySelector('thead'); const tbody = t.querySelector('tbody');
  thead.innerHTML = ''; tbody.innerHTML = '';
  thead.appendChild(rowEl(['#', 'Address', 'Amount', 'Status', 'Tx'], true));
  state.prepared.plan.forEach((p) => {
    const tr = document.createElement('tr');
    tr.id = 'run-' + p.index;
    const c0 = document.createElement('td'); c0.textContent = String(p.index + 1);
    const c1 = document.createElement('td'); const code = document.createElement('code'); code.textContent = p.address; c1.appendChild(code);
    const c2 = document.createElement('td'); c2.textContent = `${p.human} ${state.symbol}`;
    const c3 = document.createElement('td'); c3.appendChild(badge(p.paid ? 'skipped' : 'pending', p.paid ? 'already paid' : 'pending'));
    const c4 = document.createElement('td'); c4.textContent = '';
    tr.append(c0, c1, c2, c3, c4);
    tbody.appendChild(tr);
  });
}

function handleProgress(e) {
  if (e.type === 'sending') {
    setRowStatus(e.index, 'sending', 'sending…');
  } else if (e.type === 'result') {
    if (e.status === 'success') setRowStatus(e.index, 'success', 'success', e.hash, e.url);
    else if (e.status === 'failed') setRowStatus(e.index, 'failed', 'failed', e.hash, e.url, e.reason);
    else if (e.status === 'skipped') setRowStatus(e.index, 'skipped', 'skipped');
    if (e.stats) updateCounts(e.stats, e.total);
  } else if (e.type === 'stopped') {
    toast('Stopped — remaining recipients were not sent.', 'bad');
  }
}

function setRowStatus(index, status, label, hash, url, reason) {
  const tr = document.getElementById('run-' + index);
  if (!tr) return;
  const tds = tr.children;
  tds[3].innerHTML = ''; tds[3].appendChild(badge(status, label));
  if (reason) tds[3].title = reason;
  tds[4].innerHTML = '';
  if (url && hash) {
    tds[4].appendChild(txLink(url, short(hash)));
  } else if (reason) {
    // Make failure reasons (esp. broadcast failures with no hash) visible inline.
    const span = document.createElement('span');
    span.className = 'reason';
    span.textContent = reason;
    span.title = reason;
    tds[4].appendChild(span);
  }
  // Only follow the active (sending) row, so a long batch doesn't fight the
  // operator's manual scrolling on every event.
  if (status === 'sending') tr.scrollIntoView({ block: 'nearest' });
}

function updateCounts(stats, total) {
  const done = stats.success + stats.failed + stats.skipped;
  $('progressFill').style.width = total ? Math.round((done / total) * 100) + '%' : '0%';
  const c = $('counts'); c.innerHTML = '';
  const span = (label, n, cls) => { const s = document.createElement('span'); s.textContent = label + ' '; const b = document.createElement('b'); if (cls) b.className = cls; b.textContent = String(n); s.appendChild(b); return s; };
  c.append(
    span('✅', stats.success, 'success'),
    span('❌', stats.failed, 'failed'),
    span('⏭', stats.skipped, 'skipped'),
    span('of', total, ''),
  );
}

function showRunSummary(res) {
  const sum = $('runSummary'); sum.hidden = false; sum.innerHTML = '';
  const add = (txt, big) => { const d = document.createElement('div'); if (big) d.className = 'big'; d.textContent = txt; sum.appendChild(d); };
  const s = res.summary;
  add(res.stopped ? 'Run stopped early (resume by running again).' : 'Run complete.', true);
  add(`✅ ${s.success} success   ·   ❌ ${s.failed} failed   ·   ⏭ ${s.skipped} skipped`);
  add(`Total sent: ${s.sent}   ·   gas used: ${s.gasUsed} wei`);
  if (res.failures && res.failures.length) {
    const h = document.createElement('div'); h.textContent = `${res.failures.length} failed (re-run to retry just these):`; sum.appendChild(h);
    const ul = document.createElement('ul');
    res.failures.forEach((f) => { const li = document.createElement('li'); li.textContent = `${short(f.address)} — ${f.reason}`; ul.appendChild(li); });
    sum.appendChild(ul);
  }
  $('runArtifacts').hidden = false;
  $('btnOpenResults').onclick = () => api.showItem(res.resultsPath).catch(() => {});
  $('btnOpenLog').onclick = () => (res.logPath ? api.showItem(res.logPath).catch(() => {}) : toast('No log path', 'bad'));
  toast(res.stopped ? 'Stopped.' : (s.failed ? `${s.failed} failed.` : 'All payouts succeeded 🎉'), s.failed ? 'bad' : 'ok');
}

// ---- init -----------------------------------------------------------------
refreshGating();

})();
