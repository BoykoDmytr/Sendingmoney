// Sequential payout engine: manual nonce, idempotent skips, receipt-verified
// success, graceful kill switch. This is where real money moves.
import { formatUnits } from 'viem';
import { STATUS } from './ledger.js';
import { shortHash } from './util.js';

/**
 * @returns {Promise<{summary:object, failures:Array}>}
 */
export async function runPayouts({
  chain,
  ledger,
  logger,
  cfg,
  runId,
  recipients,
  decimals,
  symbol,
  gasPrice,
  gasLimit,
  stopOnError,
  killSwitch, // { stopped: boolean }
  onEvent = () => {}, // structured progress sink (GUI); no-op for the CLI
}) {
  const wallet = chain.account.address;
  const explorer = cfg.explorerUrl;
  const total = recipients.length;
  // Emit a structured event AND keep it from ever throwing into the send loop.
  const emit = (e) => {
    try {
      onEvent(e);
    } catch {
      /* a broken UI sink must never abort a payout */
    }
  };

  // Manual nonce: take the current pending nonce and increment locally so we
  // never wait on the node's view between sends.
  let nonce = await chain.pendingNonce(wallet);
  logger.info(`Starting nonce (pending): ${nonce}`);

  const stats = { success: 0, failed: 0, skipped: 0, sentWei: 0n, gasUsed: 0n };
  const failures = [];
  const snapshot = () => ({ success: stats.success, failed: stats.failed, skipped: stats.skipped });
  emit({ type: 'run-start', total, startNonce: Number(nonce) });

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const pos = `[${i + 1}/${recipients.length}]`;

    if (killSwitch.stopped) {
      logger.warn(`${pos} Stop requested — halting before sending to ${r.address}.`);
      emit({ type: 'stopped', index: i, total });
      break;
    }

    // Idempotency: already paid in this run? skip without touching the chain.
    if (ledger.isPaid(runId, r.address)) {
      stats.skipped += 1;
      logger.info(`${pos} SKIP ${r.address} — already paid in this run (${runId}).`);
      emit({ type: 'result', index: i, total, address: r.address, human: r.human, status: 'skipped', stats: snapshot() });
      continue;
    }

    const amountStr = `${r.human} ${symbol}`;
    logger.info(`${pos} Sending ${amountStr} -> ${r.address} (nonce ${nonce})`);
    emit({ type: 'sending', index: i, total, address: r.address, human: r.human, nonce: Number(nonce) });

    try {
      const { hash, receipt, confirmed } = await chain.sendTransfer({
        to: r.address,
        amountWei: r.wei,
        nonce,
        gas: gasLimit,
        gasPrice,
      });

      const url = `${explorer}/tx/${hash}`;
      const gasUsed = receipt.gasUsed ?? 0n;

      if (confirmed) {
        ledger.record({
          runId,
          address: r.address,
          amountWei: r.wei,
          amountHuman: r.human,
          status: STATUS.SUCCESS,
          txHash: hash,
          gasUsed,
          now: Date.now(),
        });
        stats.success += 1;
        stats.sentWei += r.wei;
        stats.gasUsed += gasUsed;
        logger.success(`${pos} CONFIRMED ${amountStr} -> ${r.address} | ${shortHash(hash)} | ${url}`);
        emit({ type: 'result', index: i, total, address: r.address, human: r.human, status: 'success', hash, url, gasUsed: gasUsed.toString(), stats: snapshot() });
      } else {
        // Receipt came back but status != success or no matching Transfer event.
        const reason =
          receipt.status !== 'success'
            ? `receipt status = ${receipt.status}`
            : 'no matching Transfer event in receipt';
        ledger.record({
          runId,
          address: r.address,
          amountWei: r.wei,
          amountHuman: r.human,
          status: STATUS.FAILED,
          txHash: hash,
          gasUsed,
          error: reason,
          now: Date.now(),
        });
        stats.failed += 1;
        failures.push({ address: r.address, human: r.human, reason, hash });
        logger.error(`${pos} FAILED ${r.address} — ${reason} | ${url}`);
        emit({ type: 'result', index: i, total, address: r.address, human: r.human, status: 'failed', hash, url, reason, stats: snapshot() });
        if (stopOnError) {
          logger.error('Stopping due to --stop-on-error.');
          break;
        }
      }

      // Advance nonce only after the tx is mined (success or revert both consume
      // the nonce on-chain). Reverted txs still increment the account nonce.
      nonce += 1;
    } catch (err) {
      // Non-transient failure (transient ones were already retried in Chain).
      const reason = err.shortMessage || err.message || String(err);
      ledger.record({
        runId,
        address: r.address,
        amountWei: r.wei,
        amountHuman: r.human,
        status: STATUS.FAILED,
        error: reason,
        now: Date.now(),
      });
      stats.failed += 1;
      failures.push({ address: r.address, human: r.human, reason, hash: null });
      logger.error(`${pos} FAILED ${r.address} — ${reason}`);
      emit({ type: 'result', index: i, total, address: r.address, human: r.human, status: 'failed', hash: null, reason, stats: snapshot() });

      if (stopOnError) {
        logger.error('Stopping due to --stop-on-error.');
        break;
      }
      // The tx likely did not broadcast; re-sync the nonce from the node so we
      // recover from any drift before the next recipient.
      try {
        nonce = await chain.pendingNonce(wallet);
        logger.warn(`Re-synced nonce from node: ${nonce}`);
      } catch {
        nonce += 1; // best effort
      }
    }
  }

  const summary = {
    success: stats.success,
    failed: stats.failed,
    skipped: stats.skipped,
    sent: `${formatUnits(stats.sentWei, decimals)} ${symbol}`,
    sentWei: stats.sentWei.toString(),
    gasUsed: stats.gasUsed.toString(),
  };

  emit({ type: 'run-done', summary, failures, stopped: killSwitch.stopped });
  return { summary, failures };
}
