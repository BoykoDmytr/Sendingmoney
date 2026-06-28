// Programmatic, stateful facade over the payout core — used by the desktop GUI
// (Electron main process) and by headless tests. Mirrors the CLI's safety order
// but exposes structured, JSON-serializable results and a progress event stream.
//
// SECURITY: the private key lives ONLY inside this object (main process memory).
// It is never returned to a caller, never logged, never written to disk.
import { mkdirSync } from 'node:fs';
import { formatUnits, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { buildConfig, validatePrivateKey, redactedConfig, DEFAULTS } from './config.js';
import { Logger } from './logger.js';
import { Chain } from './chain.js';
import { parsePayouts } from './parse.js';
import { preflight as runPreflight } from './preflight.js';
import { runPayouts } from './payout.js';
import { Ledger, deriveRunId } from './ledger.js';
import { exportResults } from './report.js';
import { parseAmount, sumBig } from './util.js';

const toSendableRecipient = (r) => ({ row: r.row, address: r.address, human: r.human, wei: r.wei.toString() });

export class PayoutEngine {
  constructor({ dataPath = 'data/payouts.sqlite', resultsDir = '.', logsDir = 'logs' } = {}) {
    this.dataPath = dataPath;
    this.resultsDir = resultsDir;
    this.logsDir = logsDir;
    try { mkdirSync(resultsDir, { recursive: true }); } catch { /* ignore */ }
    this.cfg = null;
    this.chain = null;
    this.account = null; // viem account (holds key material) — never serialized out
    this.token = null; // { symbol, decimals }
    this.sessionLogger = null;
    this.runLogger = null;
    this.ledger = null;
    this.prepared = null; // { mode, recipients[], runId, decimals, symbol }
    this.killSwitch = { stopped: false };
  }

  // --- configuration ------------------------------------------------------

  /** Apply GUI settings (no key). Resets any built chain. Returns redacted view. */
  configure(input = {}) {
    this.cfg = buildConfig({ ...input, privateKey: undefined });
    // Preserve an already-unlocked key across reconfiguration.
    if (this._key) this.cfg.privateKey = this._key;
    this.chain = null;
    this.token = null;
    if (!this.sessionLogger) this.sessionLogger = new Logger({ mode: 'session', dir: this.logsDir });
    this.sessionLogger.info(`Config applied: ${JSON.stringify(redactedConfig(this.cfg))}`);
    return { ...redactedConfig(this.cfg), defaults: DEFAULTS };
  }

  /** Validate + load the private key into memory. Returns ONLY the derived address. */
  unlock(privateKey) {
    const pk = validatePrivateKey(privateKey, { required: true });
    const account = privateKeyToAccount(pk);
    this._key = pk;
    this.account = account;
    if (this.cfg) this.cfg.privateKey = pk;
    this.chain = null; // force rebuild with wallet
    this.sessionLogger?.info(`Wallet unlocked: ${account.address}`);
    return { address: account.address };
  }

  /** Wipe the key from memory. */
  lock() {
    this._key = null;
    this.account = null;
    if (this.cfg) this.cfg.privateKey = null;
    this.chain = null;
    this.sessionLogger?.info('Wallet locked (key wiped from memory).');
    return { locked: true };
  }

  isUnlocked() {
    return Boolean(this._key);
  }

  _requireConfig() {
    if (!this.cfg) throw new Error('Not configured yet. Apply settings first.');
  }

  _ensureChain() {
    this._requireConfig();
    if (!this.chain) {
      this.chain = new Chain({ cfg: this.cfg, logger: this.sessionLogger });
    }
    return this.chain;
  }

  // --- connect + token guard ---------------------------------------------

  /**
   * Connect to RPC, read token symbol/decimals on-chain and verify they match
   * the expected values (wrong-contract guard). Returns a status object.
   */
  async connect() {
    const chain = this._ensureChain();
    const { symbol, decimals } = await chain.readToken();
    this.token = { symbol, decimals };

    const decimalsOk = decimals === this.cfg.expectedDecimals;
    const symbolOk = symbol.toUpperCase() === this.cfg.expectedSymbol.toUpperCase();
    let reason = null;
    if (!decimalsOk) reason = `On-chain decimals (${decimals}) != expected (${this.cfg.expectedDecimals}). Wrong contract?`;
    else if (!symbolOk) reason = `On-chain symbol (${symbol}) != expected (${this.cfg.expectedSymbol}). Wrong contract?`;

    let walletAddress = this.account?.address ?? null;
    let usdtBalance = null;
    let bnbBalance = null;
    if (walletAddress) {
      [usdtBalance, bnbBalance] = await Promise.all([
        chain.tokenBalance(walletAddress),
        chain.nativeBalance(walletAddress),
      ]);
    }

    this.sessionLogger?.info(`Connected via ${chain.activeRpc}; token ${symbol}/${decimals}; ok=${Boolean(!reason)}`);
    return {
      ok: !reason,
      reason,
      symbol,
      decimals,
      tokenAddress: this.cfg.tokenAddress,
      chainId: this.cfg.chainId,
      rpc: chain.activeRpc,
      walletAddress,
      usdtBalance: usdtBalance == null ? null : formatUnits(usdtBalance, decimals),
      bnbBalance: bnbBalance == null ? null : formatEther(bnbBalance),
    };
  }

  // --- validation ---------------------------------------------------------

  /** Parse + validate a spreadsheet. Requires connect() first (needs decimals). */
  validate(filePath) {
    if (!this.token) throw new Error('Connect first so the token decimals are known.');
    const { recipients, errors, duplicates, ignored, sheetName, headerRow, addrHeader, amtHeader } =
      parsePayouts(filePath, this.token.decimals);
    const total = sumBig(recipients.map((r) => r.wei));
    this.sessionLogger?.info(
      `Validated ${filePath} [sheet "${sheetName}", header row ${headerRow}: "${addrHeader}" / "${amtHeader}"]: ${recipients.length} ok, ${errors.length} errors, ${ignored.length} ignored, ${duplicates.length} dup-addresses.`,
    );
    return {
      recipients: recipients.map(toSendableRecipient),
      errors,
      duplicates,
      ignored,
      sheetName,
      headerRow,
      addrHeader,
      amtHeader,
      totalHuman: formatUnits(total, this.token.decimals),
      symbol: this.token.symbol,
      decimals: this.token.decimals,
    };
  }

  _resolveDuplicates(recipients, duplicates, policy) {
    if (duplicates.length === 0) return recipients;
    if (policy !== 'sum') {
      throw new Error(`Duplicate addresses present and policy is "reject". Choose "sum" to merge, or clean the file.`);
    }
    const byAddr = new Map();
    for (const r of recipients) {
      if (!byAddr.has(r.address)) byAddr.set(r.address, { ...r });
      else byAddr.get(r.address).wei += r.wei;
    }
    return [...byAddr.values()].map((r) => ({ ...r, human: formatUnits(r.wei, this.token.decimals) }));
  }

  // --- prepare a concrete run --------------------------------------------

  /**
   * Resolve duplicates, apply test-amount substitution, derive the run id and
   * open the ledger. Returns the plan (with per-address ledger status).
   * @param {object} a
   * @param {string} a.filePath
   * @param {'dry-run'|'test'|'execute'} a.mode
   * @param {'reject'|'sum'} a.duplicatePolicy
   */
  prepare({ filePath, mode, duplicatePolicy = 'reject' }) {
    if (!this.token) throw new Error('Connect first.');
    const { recipients, errors, duplicates } = parsePayouts(filePath, this.token.decimals);
    if (errors.length > 0) throw new Error(`File has ${errors.length} invalid row(s); fix them before preparing.`);
    if (recipients.length === 0) throw new Error('No valid recipients in the file.');

    let resolved = this._resolveDuplicates(recipients, duplicates, duplicatePolicy);

    if (mode === 'test') {
      const { wei, human } = parseAmount(this.cfg.testAmount, this.token.decimals);
      resolved = resolved.map((r) => ({ ...r, wei, human }));
    }

    const runId = deriveRunId({
      recipients: resolved,
      tokenAddress: this.cfg.tokenAddress,
      chainId: this.cfg.chainId,
      mode: mode === 'dry-run' ? 'execute' : mode, // dry-run previews the execute ledger
      testAmount: this.cfg.testAmount,
    });

    // (Re)open the ledger and a fresh per-run log file.
    if (!this.ledger) this.ledger = new Ledger(this.dataPath);
    this.ledger.registerRun({
      runId, mode, token: this.cfg.tokenAddress, chainId: this.cfg.chainId, recipients: resolved.length, now: Date.now(),
    });
    if (this.runLogger) this.runLogger.close().catch(() => {});
    this.runLogger = new Logger({ mode, dir: this.logsDir });

    this.prepared = { mode, recipients: resolved, runId, decimals: this.token.decimals, symbol: this.token.symbol };

    const plan = resolved.map((r, i) => ({
      index: i,
      address: r.address,
      human: r.human,
      paid: this.ledger.isPaid(runId, r.address),
    }));
    const alreadyPaid = plan.filter((p) => p.paid).length;
    const totalAll = sumBig(resolved.map((r) => r.wei));
    const totalPending = sumBig(resolved.filter((r) => !this.ledger.isPaid(runId, r.address)).map((r) => r.wei));

    this.runLogger.info(`Prepared run ${runId} (${mode}): ${resolved.length} recipients, ${alreadyPaid} already paid.`);
    return {
      mode, runId, plan, alreadyPaid,
      count: resolved.length,
      symbol: this.token.symbol,
      decimals: this.token.decimals,
      totalAllHuman: formatUnits(totalAll, this.token.decimals),
      totalPendingHuman: formatUnits(totalPending, this.token.decimals),
      duplicatesMerged: duplicatePolicy === 'sum' && duplicates.length > 0,
    };
  }

  // --- pre-flight ---------------------------------------------------------

  async preflight() {
    if (!this.prepared) throw new Error('Call prepare() first.');
    const chain = this._ensureChain();
    const { recipients, decimals, symbol, runId } = this.prepared;
    const pending = recipients.filter((r) => !this.ledger.isPaid(runId, r.address));
    const pf = await runPreflight({ chain, cfg: this.cfg, logger: this.runLogger, recipients: pending, decimals, symbol });

    const fmt = (b) => (b == null ? null : formatUnits(b, decimals));
    return {
      ok: pf.ok,
      problems: pf.problems,
      pendingCount: pending.length,
      symbol, decimals,
      tokenAddress: this.cfg.tokenAddress,
      wallet: this.account?.address ?? null,
      totalPendingHuman: formatUnits(pf.totalWei, decimals),
      usdtBalanceHuman: fmt(pf.usdtBalance),
      bnbBalanceHuman: pf.bnbBalance == null ? null : formatEther(pf.bnbBalance),
      gasPriceGwei: formatUnits(pf.gasPrice, 9),
      gasPerTx: pf.gasPerTx.toString(),
      gasBudgetMaxBnb: formatEther(pf.gasBnb),
      _gasPrice: pf.gasPrice.toString(), // kept for the run; not for display
    };
  }

  // --- execute the run ----------------------------------------------------

  /**
   * Send the prepared run. Requires a non-dry-run mode, an unlocked wallet AND
   * explicit confirmation (confirm === 'YES'), mirroring the CLI's YES gate so
   * the core itself never sends without confirmation.
   * @param {object} a
   * @param {function} a.onEvent  progress sink
   * @param {boolean}  a.stopOnError
   * @param {string}   a.confirm   must be the literal 'YES' for test/execute
   */
  async run({ onEvent = () => {}, stopOnError = false, confirm } = {}) {
    if (!this.prepared) throw new Error('Call prepare() first.');
    if (this.prepared.mode === 'dry-run') throw new Error('dry-run does not send. Use test or execute.');
    if (!this.isUnlocked()) throw new Error('Wallet is locked. Unlock with the private key first.');
    if (confirm !== 'YES') throw new Error('Refusing to send without explicit confirmation (confirm must be "YES").');

    const chain = this._ensureChain();
    if (!chain.account) throw new Error('No wallet account on the chain client.');

    const { mode, recipients, runId, decimals, symbol } = this.prepared;

    // Nothing left to send (e.g. resuming a fully-completed run): export the
    // existing results and return a no-op summary, mirroring the CLI.
    const pending = recipients.filter((r) => !this.ledger.isPaid(runId, r.address));
    if (pending.length === 0) {
      const out = `${this.resultsDir.replace(/\/+$/, '')}/${mode === 'test' ? 'results-test.xlsx' : 'results.xlsx'}`;
      const { count: rows } = exportResults({ ledger: this.ledger, runId, cfg: this.cfg, outPath: out });
      this.runLogger?.success('Nothing left to send — all recipients already paid in this run.');
      return {
        summary: { success: 0, failed: 0, skipped: recipients.length, sent: `0 ${symbol}`, sentWei: '0', gasUsed: '0' },
        failures: [],
        resultsPath: out,
        resultsRows: rows,
        logPath: this.runLogger?.path ?? null,
        stopped: false,
      };
    }

    // Re-run pre-flight defensively right before sending.
    const pf = await this.preflight();
    if (!pf.ok) {
      const msg = `Pre-flight failed: ${pf.problems.join(' ')}`;
      this.runLogger?.error(msg);
      throw new Error(msg);
    }

    this.killSwitch = { stopped: false };

    const { summary, failures } = await runPayouts({
      chain,
      ledger: this.ledger,
      logger: this.runLogger,
      cfg: this.cfg,
      runId,
      recipients,
      decimals,
      symbol,
      gasPrice: BigInt(pf._gasPrice),
      gasLimit: this.cfg.gasLimitPerTx,
      stopOnError,
      killSwitch: this.killSwitch,
      onEvent,
    });

    const outName = mode === 'test' ? 'results-test.xlsx' : 'results.xlsx';
    const outPath = `${this.resultsDir.replace(/\/+$/, '')}/${outName}`;
    const { count } = exportResults({ ledger: this.ledger, runId, cfg: this.cfg, outPath });

    const logPath = this.runLogger?.path ?? null;
    return {
      summary,
      failures,
      resultsPath: outPath,
      resultsRows: count,
      logPath,
      stopped: this.killSwitch.stopped,
    };
  }

  /** Kill switch — finish the in-flight tx, then stop cleanly. */
  stop() {
    this.killSwitch.stopped = true;
    this.runLogger?.warn('Stop requested via UI — finishing the in-flight transaction.');
    return { stopping: true };
  }

  /** Current results rows for the prepared run (for the results table). */
  resultRows() {
    if (!this.prepared || !this.ledger) return [];
    return this.ledger.rowsForRun(this.prepared.runId).map((r) => ({
      address: r.address,
      amount: r.amount_human,
      status: r.status,
      txHash: r.tx_hash || '',
      url: r.tx_hash ? `${this.cfg.explorerUrl}/tx/${r.tx_hash}` : '',
      error: r.error || '',
    }));
  }

  async dispose() {
    this.lock();
    try { this.ledger?.close(); } catch {}
    try { await this.runLogger?.close(); } catch {}
    try { await this.sessionLogger?.close(); } catch {}
    this.ledger = null;
    this.runLogger = null;
    this.sessionLogger = null;
  }
}
