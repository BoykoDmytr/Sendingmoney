// Idempotency ledger backed by SQLite (better-sqlite3, synchronous).
//
// The unit of idempotency is (run_id, address). A `run_id` is derived
// deterministically from the recipient list + token + chain + mode, so
// re-running the exact same distribution resumes where it left off and an
// already-successfully-paid address is skipped — no double payments.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const STATUS = {
  SUCCESS: 'success',
  FAILED: 'failed',
  SENT_UNKNOWN: 'sent-unknown', // tx broadcast but receipt status not confirmed success
};

/**
 * Deterministic run id. Same recipients + token + chain + mode => same id.
 * `mode` keeps the test run isolated in its own ledger namespace.
 */
export function deriveRunId({ recipients, tokenAddress, chainId, mode, testAmount }) {
  const h = createHash('sha256');
  h.update(`mode:${mode}\n`);
  if (mode.startsWith('test')) h.update(`testAmount:${testAmount}\n`);
  h.update(`token:${tokenAddress.toLowerCase()}\n`);
  h.update(`chain:${chainId}\n`);
  // Order-independent: sort by address so row reordering doesn't change the id.
  const lines = recipients
    .map((r) => `${r.address.toLowerCase()}:${mode.startsWith('test') ? testAmount : r.human}`)
    .sort();
  for (const l of lines) h.update(l + '\n');
  const digest = h.digest('hex').slice(0, 16);
  return `${mode}-${digest}`;
}

export class Ledger {
  constructor(path = 'data/payouts.sqlite') {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id     TEXT PRIMARY KEY,
        mode       TEXT NOT NULL,
        token      TEXT NOT NULL,
        chain_id   INTEGER NOT NULL,
        recipients INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payouts (
        run_id       TEXT NOT NULL,
        address      TEXT NOT NULL,
        amount_wei   TEXT NOT NULL,
        amount_human TEXT NOT NULL,
        status       TEXT NOT NULL,
        tx_hash      TEXT,
        gas_used     TEXT,
        error        TEXT,
        ts           INTEGER NOT NULL,
        PRIMARY KEY (run_id, address)
      );
    `);

    this._upsert = this.db.prepare(`
      INSERT INTO payouts (run_id, address, amount_wei, amount_human, status, tx_hash, gas_used, error, ts)
      VALUES (@run_id, @address, @amount_wei, @amount_human, @status, @tx_hash, @gas_used, @error, @ts)
      ON CONFLICT(run_id, address) DO UPDATE SET
        amount_wei   = excluded.amount_wei,
        amount_human = excluded.amount_human,
        status       = excluded.status,
        tx_hash      = excluded.tx_hash,
        gas_used     = excluded.gas_used,
        error        = excluded.error,
        ts           = excluded.ts
    `);
    this._getOne = this.db.prepare('SELECT * FROM payouts WHERE run_id = ? AND address = ?');
    this._getRun = this.db.prepare('SELECT * FROM payouts WHERE run_id = ? ORDER BY ts');
    this._touchRun = this.db.prepare(`
      INSERT INTO runs (run_id, mode, token, chain_id, recipients, created_at)
      VALUES (@run_id, @mode, @token, @chain_id, @recipients, @created_at)
      ON CONFLICT(run_id) DO NOTHING
    `);
  }

  registerRun({ runId, mode, token, chainId, recipients, now }) {
    this._touchRun.run({
      run_id: runId,
      mode,
      token,
      chain_id: chainId,
      recipients,
      created_at: now,
    });
  }

  /** True if this address was already paid successfully in this run. */
  isPaid(runId, address) {
    const row = this._getOne.get(runId, address);
    return Boolean(row && row.status === STATUS.SUCCESS);
  }

  getRow(runId, address) {
    return this._getOne.get(runId, address);
  }

  record({ runId, address, amountWei, amountHuman, status, txHash = null, gasUsed = null, error = null, now }) {
    this._upsert.run({
      run_id: runId,
      address,
      amount_wei: amountWei.toString(),
      amount_human: amountHuman,
      status,
      tx_hash: txHash,
      gas_used: gasUsed == null ? null : gasUsed.toString(),
      error: error ? String(error).slice(0, 500) : null,
      ts: now,
    });
  }

  rowsForRun(runId) {
    return this._getRun.all(runId);
  }

  close() {
    this.db.close();
  }
}
