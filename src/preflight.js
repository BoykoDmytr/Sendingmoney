// Pre-flight checks: verify the payout wallet can actually cover the whole run
// (USDT for the transfers, BNB for gas) BEFORE a single tx is broadcast.
import { formatUnits, formatEther } from 'viem';
import { sumBig, renderTable } from './util.js';

/**
 * @param {object} a
 * @param {Chain}  a.chain
 * @param {object} a.cfg
 * @param {Logger} a.logger
 * @param {Array}  a.recipients  list with .wei (already test-amount-substituted if --test)
 * @param {number} a.decimals
 * @param {string} a.symbol
 * @returns {Promise<{ok:boolean, totalWei:bigint, gasPrice:bigint, gasPerTx:bigint, gasBnb:bigint, usdtBalance:bigint, bnbBalance:bigint, problems:string[]}>}
 */
export async function preflight({ chain, cfg, logger, recipients, decimals, symbol }) {
  const wallet = chain.account?.address ?? null;
  const count = recipients.length;
  const totalWei = sumBig(recipients.map((r) => r.wei));

  if (count === 0) {
    return { ok: true, totalWei: 0n, gasPrice: 0n, gasPerTx: 0n, gasBnb: 0n, usdtBalance: null, bnbBalance: null, problems: [] };
  }

  let usdtBalance = null;
  let bnbBalance = null;
  let gasPrice;
  if (wallet) {
    logger.info(`Reading on-chain balances for payout wallet ${wallet} ...`);
    [usdtBalance, bnbBalance, gasPrice] = await Promise.all([
      chain.tokenBalance(wallet),
      chain.nativeBalance(wallet),
      chain.gasPrice(),
    ]);
  } else {
    logger.warn('No PRIVATE_KEY loaded — balance checks skipped (dry-run preview only).');
    gasPrice = await chain.gasPrice();
  }

  // Estimate gas for one representative transfer; fall back to the configured
  // fixed limit if the node refuses to estimate (e.g. insufficient balance).
  let gasPerTx;
  try {
    gasPerTx = await chain.estimateTransferGas(recipients[0].address, recipients[0].wei);
  } catch (e) {
    gasPerTx = cfg.gasLimitPerTx;
    logger.warn(`Gas estimate failed (${e.shortMessage || e.message}); using configured limit ${gasPerTx}.`);
  }

  // Worst-case gas budget uses the (generous) per-tx gas LIMIT, not just the
  // estimate, because that limit is what each tx may consume.
  const perTxBudget = gasPerTx > cfg.gasLimitPerTx ? gasPerTx : cfg.gasLimitPerTx;
  const gasBnb = perTxBudget * gasPrice * BigInt(count);
  const gasBnbEstimate = gasPerTx * gasPrice * BigInt(count);

  const problems = [];
  if (wallet) {
    if (usdtBalance < totalWei) {
      const short = totalWei - usdtBalance;
      problems.push(
        `Insufficient ${symbol}: need ${formatUnits(totalWei, decimals)}, have ${formatUnits(usdtBalance, decimals)} (short ${formatUnits(short, decimals)}).`,
      );
    }
    if (bnbBalance < gasBnb) {
      const short = gasBnb - bnbBalance;
      problems.push(
        `Insufficient BNB for gas: need up to ~${formatEther(gasBnb)} BNB, have ${formatEther(bnbBalance)} BNB. Top up at least ${formatEther(short)} BNB.`,
      );
    }
  }

  const summary = renderTable(
    ['Field', 'Value'],
    [
      ['Recipients', String(count)],
      ['Token', `${symbol} (${decimals} decimals)`],
      ['Token address', cfg.tokenAddress],
      ['Total to send', `${formatUnits(totalWei, decimals)} ${symbol}`],
      ['Payout wallet', wallet ?? '(no key loaded)'],
      [`${symbol} balance`, usdtBalance == null ? 'n/a' : formatUnits(usdtBalance, decimals)],
      ['BNB balance', bnbBalance == null ? 'n/a' : formatEther(bnbBalance)],
      ['Gas price', `${formatUnits(gasPrice, 9)} gwei`],
      ['Gas / tx (est.)', String(gasPerTx)],
      ['Gas budget (est.)', `~${formatEther(gasBnbEstimate)} BNB`],
      ['Gas budget (max)', `~${formatEther(gasBnb)} BNB`],
    ],
  );

  logger.block('\n=== PRE-FLIGHT SUMMARY ===\n' + summary + '\n');

  return {
    ok: problems.length === 0,
    totalWei,
    gasPrice,
    gasPerTx,
    gasBnb,
    usdtBalance,
    bnbBalance,
    problems,
  };
}
