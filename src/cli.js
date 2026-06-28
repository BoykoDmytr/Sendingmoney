#!/usr/bin/env node
// USDT (BEP-20) batch payout CLI — entry point & orchestration.
//
// Order of operations (fail closed at every step):
//   parse+validate file -> resolve duplicates -> connect & read token (guarded)
//   -> pre-flight balances/gas -> [dry-run stops here] -> explicit confirmation
//   -> sequential idempotent sends -> results.xlsx + summary.
import { createInterface } from 'node:readline/promises';
import { formatUnits } from 'viem';

import { loadConfig, redactedConfig } from './config.js';
import { Logger } from './logger.js';
import { Chain } from './chain.js';
import { parsePayouts } from './parse.js';
import { preflight } from './preflight.js';
import { runPayouts } from './payout.js';
import { Ledger, deriveRunId } from './ledger.js';
import { exportResults } from './report.js';
import { parseAmount, renderTable, sumBig } from './util.js';

const HELP = `
USDT (BEP-20) batch payout CLI

Usage:
  payout [options]

Modes (mutually exclusive; default is --dry-run):
  --dry-run            Validate, run pre-flight and print the full plan. NO transactions. (default)
  --test               Send TEST_AMOUNT to EVERY address (real but cheap), isolated ledger.
  --execute            Send the REAL amounts from the file.

Options:
  --file <path>        Input spreadsheet (default: payouts.xlsx)
  --yes                Skip the interactive YES confirmation (for automation).
  --stop-on-error      Halt on the first failed transfer instead of continuing.
  --duplicates <mode>  How to handle duplicate addresses: "reject" (default) or "sum".
  --help               Show this help.

Safety:
  * Real sends require --execute (or --test) AND an explicit "YES" (or --yes).
  * Amounts are converted with the token's ON-CHAIN decimals (USDT on BSC = 18).
  * An idempotent SQLite ledger means a re-run resumes without double-paying.

Recommended order:  --dry-run  ->  --test  ->  --execute
`;

function parseArgs(argv) {
  const o = {
    mode: 'dry-run',
    file: 'payouts.xlsx',
    yes: false,
    stopOnError: false,
    duplicates: null, // null => decide interactively
    help: false,
  };
  let explicitDryRun = false;
  let wantsExecute = false;
  let wantsTest = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--help':
      case '-h':
        o.help = true;
        break;
      case '--dry-run':
        explicitDryRun = true;
        break;
      case '--execute':
        wantsExecute = true;
        break;
      case '--test':
        wantsTest = true;
        break;
      case '--yes':
      case '-y':
        o.yes = true;
        break;
      case '--stop-on-error':
        o.stopOnError = true;
        break;
      case '--file':
        o.file = argv[++i];
        break;
      case '--duplicates':
        o.duplicates = String(argv[++i] || '').toLowerCase();
        break;
      default:
        if (a.startsWith('--file=')) o.file = a.slice(7);
        else if (a.startsWith('--duplicates=')) o.duplicates = a.slice(13).toLowerCase();
        else throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (wantsTest && wantsExecute) throw new Error('--test and --execute are mutually exclusive.');
  if (o.duplicates && !['reject', 'sum'].includes(o.duplicates)) {
    throw new Error('--duplicates must be "reject" or "sum".');
  }

  // --dry-run is a hard safety override: if present, never send.
  if (explicitDryRun) o.mode = 'dry-run';
  else if (wantsExecute) o.mode = 'execute';
  else if (wantsTest) o.mode = 'test';
  return o;
}

async function ask(question) {
  if (!process.stdin.isTTY) return null; // non-interactive
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Collapse duplicate addresses according to `decision` (reject | sum). */
function resolveDuplicates(recipients, duplicates, decision, decimals, logger) {
  if (duplicates.length === 0) return recipients;

  const tbl = renderTable(
    ['Address', 'Rows', 'Count'],
    duplicates.map((d) => [d.address, d.rows.join(', '), String(d.rows.length)]),
  );
  logger.warn(`Found ${duplicates.length} duplicate address(es):\n${tbl}`);

  if (decision === 'reject') {
    throw new Error(
      'Duplicate addresses present and policy is "reject". Clean the file or re-run with --duplicates sum.',
    );
  }

  // sum
  const byAddr = new Map();
  for (const r of recipients) {
    if (!byAddr.has(r.address)) byAddr.set(r.address, { ...r });
    else byAddr.get(r.address).wei += r.wei;
  }
  const merged = [...byAddr.values()].map((r) => ({
    ...r,
    human: formatUnits(r.wei, decimals),
  }));
  logger.warn(`Duplicates SUMMED: ${recipients.length} rows -> ${merged.length} unique recipients.`);
  return merged;
}

function printPlan({ logger, recipients, runId, ledger, symbol, mode }) {
  const preview = recipients.slice(0, 25).map((r, i) => {
    const paid = ledger.isPaid(runId, r.address);
    return [String(i + 1), r.address, `${r.human} ${symbol}`, paid ? 'already paid (skip)' : 'pending'];
  });
  const tbl = renderTable(['#', 'Address', 'Amount', 'Ledger'], preview);
  const more = recipients.length > 25 ? `\n... and ${recipients.length - 25} more (full list in the log file)` : '';
  logger.block(`\n=== PAYOUT PLAN (${mode}, run_id=${runId}) ===\n${tbl}${more}\n`);
  // Full list to log file only.
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    logger.stream.write(
      `${new Date().toISOString()} [PLAN] ${i + 1}\t${r.address}\t${r.human} ${symbol}\t${ledger.isPaid(runId, r.address) ? 'skip' : 'pending'}\n`,
    );
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const needsWallet = opts.mode !== 'dry-run';
  const cfg = loadConfig({ needsWallet });
  const logger = new Logger({ mode: opts.mode });

  logger.info(`USDT batch payout — mode: ${opts.mode.toUpperCase()}`);
  logger.info(`Config: ${JSON.stringify(redactedConfig(cfg))}`);
  logger.info(`Log file: ${logger.path}`);

  const chain = new Chain({ cfg, logger });
  logger.info(`RPC endpoint: ${chain.activeRpc} (chainId ${cfg.chainId})`);

  // --- token metadata (on-chain) + safety guard --------------------------
  const { symbol, decimals } = await chain.readToken();
  logger.info(`Token on-chain: symbol=${symbol}, decimals=${decimals} @ ${cfg.tokenAddress}`);
  if (decimals !== cfg.expectedDecimals) {
    logger.error(
      `On-chain decimals (${decimals}) != expected (${cfg.expectedDecimals}). Refusing to run — wrong contract? Override EXPECTED_DECIMALS only if you are certain.`,
    );
    await logger.close();
    return 1;
  }
  if (symbol.toUpperCase() !== cfg.expectedSymbol.toUpperCase()) {
    logger.error(
      `On-chain symbol (${symbol}) != expected (${cfg.expectedSymbol}). Refusing to run — wrong contract? Override EXPECTED_SYMBOL if intentional.`,
    );
    await logger.close();
    return 1;
  }

  // --- parse + validate file ---------------------------------------------
  logger.info(`Parsing & validating ${opts.file} ...`);
  const { recipients: parsed, errors, duplicates } = parsePayouts(opts.file, decimals);

  if (errors.length > 0) {
    const tbl = renderTable(
      ['Row', 'Address', 'Amount', 'Problem'],
      errors.map((e) => [String(e.row), e.address || '(empty)', e.amount || '(empty)', e.reason]),
    );
    logger.error(`Found ${errors.length} invalid row(s). NOTHING will be sent. Fix these and re-run:\n${tbl}`);
    await logger.close();
    return 1;
  }
  if (parsed.length === 0) {
    logger.error('No valid recipients found in the file.');
    await logger.close();
    return 1;
  }
  logger.success(`Validation passed: ${parsed.length} valid row(s), 0 errors.`);

  // --- duplicates ---------------------------------------------------------
  let decision = opts.duplicates;
  if (duplicates.length > 0 && !decision) {
    const ans = await ask(
      `\nFound ${duplicates.length} duplicate address(es). Type "sum" to add their amounts, anything else to reject: `,
    );
    decision = ans && ans.toLowerCase() === 'sum' ? 'sum' : 'reject';
    if (ans === null) logger.warn('Non-interactive session and no --duplicates flag: defaulting to "reject".');
  }
  let recipients;
  try {
    recipients = resolveDuplicates(parsed, duplicates, decision || 'reject', decimals, logger);
  } catch (e) {
    logger.error(e.message);
    await logger.close();
    return 1;
  }

  // --- test-mode amount substitution -------------------------------------
  if (opts.mode === 'test') {
    const { wei, human } = parseAmount(cfg.testAmount, decimals);
    recipients = recipients.map((r) => ({ ...r, wei, human }));
    logger.info(`TEST mode: every recipient will receive ${human} ${symbol}.`);
  }

  // --- run id + ledger ----------------------------------------------------
  const runId = deriveRunId({
    recipients,
    tokenAddress: cfg.tokenAddress,
    chainId: cfg.chainId,
    mode: opts.mode === 'dry-run' ? 'execute' : opts.mode, // dry-run previews the execute ledger
    testAmount: cfg.testAmount,
  });
  const ledger = new Ledger();
  ledger.registerRun({
    runId,
    mode: opts.mode,
    token: cfg.tokenAddress,
    chainId: cfg.chainId,
    recipients: recipients.length,
    now: Date.now(),
  });

  const alreadyPaid = recipients.filter((r) => ledger.isPaid(runId, r.address)).length;
  if (alreadyPaid > 0) logger.info(`Ledger: ${alreadyPaid}/${recipients.length} already paid in run ${runId} (will skip).`);

  printPlan({ logger, recipients, runId, ledger, symbol, mode: opts.mode });

  // --- pre-flight ---------------------------------------------------------
  const pending = recipients.filter((r) => !ledger.isPaid(runId, r.address));
  const pf = await preflight({ chain, cfg, logger, recipients: pending, decimals, symbol });

  const totalAll = sumBig(recipients.map((r) => r.wei));
  logger.info(
    `Totals — all recipients: ${formatUnits(totalAll, decimals)} ${symbol}; remaining to send now: ${formatUnits(pf.totalWei, decimals)} ${symbol}.`,
  );

  // --- dry-run stops here -------------------------------------------------
  if (opts.mode === 'dry-run') {
    if (!pf.ok) {
      logger.warn('Pre-flight problems (would block a real run):');
      pf.problems.forEach((p) => logger.warn(`  - ${p}`));
    }
    logger.success('DRY RUN complete — no transactions were sent. Re-run with --test, then --execute.');
    ledger.close();
    await logger.close();
    return 0;
  }

  if (!pf.ok) {
    logger.error('Pre-flight failed — refusing to send:');
    pf.problems.forEach((p) => logger.error(`  - ${p}`));
    ledger.close();
    await logger.close();
    return 1;
  }

  if (pending.length === 0) {
    logger.success('Nothing left to send — all recipients already paid in this run.');
    const out = opts.mode === 'test' ? 'results-test.xlsx' : 'results.xlsx';
    exportResults({ ledger, runId, cfg, outPath: out });
    ledger.close();
    await logger.close();
    return 0;
  }

  // --- explicit confirmation ---------------------------------------------
  const verb = opts.mode === 'test' ? `send ${cfg.testAmount} ${symbol} to each of` : 'pay';
  if (!opts.yes) {
    const ans = await ask(
      `\n⚠️  About to ${verb} ${pending.length} address(es) for a total of ${formatUnits(pf.totalWei, decimals)} ${symbol} on chain ${cfg.chainId}.\nType "YES" (uppercase) to proceed: `,
    );
    if (ans !== 'YES') {
      logger.error(`Confirmation not given (got "${ans ?? 'no input'}"). Aborting. Use --yes for automation.`);
      ledger.close();
      await logger.close();
      return 1;
    }
  } else {
    logger.warn('--yes supplied: skipping interactive confirmation.');
  }

  // --- kill switch --------------------------------------------------------
  const killSwitch = { stopped: false };
  let sigintCount = 0;
  const onSigint = () => {
    sigintCount += 1;
    if (sigintCount === 1) {
      killSwitch.stopped = true;
      logger.warn('SIGINT received — will finish the in-flight tx, record it, then stop cleanly. Ctrl+C again to force-quit.');
    } else {
      logger.error('Second SIGINT — forcing exit (ledger may need a resume run).');
      process.exit(130);
    }
  };
  process.on('SIGINT', onSigint);

  // --- send ---------------------------------------------------------------
  const { summary, failures } = await runPayouts({
    chain,
    ledger,
    logger,
    cfg,
    runId,
    recipients,
    decimals,
    symbol,
    gasPrice: pf.gasPrice,
    gasLimit: cfg.gasLimitPerTx,
    stopOnError: opts.stopOnError,
    killSwitch,
  });
  process.off('SIGINT', onSigint);

  // --- report + summary ---------------------------------------------------
  const out = opts.mode === 'test' ? 'results-test.xlsx' : 'results.xlsx';
  const { outPath, count } = exportResults({ ledger, runId, cfg, outPath: out });

  logger.block(
    '\n=== FINAL SUMMARY ===\n' +
      renderTable(
        ['Metric', 'Value'],
        [
          ['Mode', opts.mode],
          ['Run id', runId],
          ['Succeeded', String(summary.success)],
          ['Failed', String(summary.failed)],
          ['Skipped (already paid)', String(summary.skipped)],
          ['Total sent', summary.sent],
          ['Gas used (wei)', summary.gasUsed],
          ['Results file', `${outPath} (${count} rows)`],
          ['Log file', logger.path],
        ],
      ),
  );

  if (failures.length > 0) {
    const tbl = renderTable(
      ['Address', 'Amount', 'Reason', 'Tx'],
      failures.map((f) => [f.address, f.human, f.reason, f.hash || '(not broadcast)']),
    );
    logger.error(`${failures.length} transfer(s) failed — re-run the same command to retry just these:\n${tbl}`);
  }

  if (killSwitch.stopped) {
    logger.warn('Run stopped early by kill switch. Re-run the same command to resume the remaining recipients.');
  } else if (summary.failed === 0) {
    logger.success('All payouts completed successfully. 🎉');
  }

  ledger.close();
  await logger.close();
  return summary.failed > 0 ? 2 : 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(`❌ Fatal: ${err.shortMessage || err.message}`);
    if (process.env.DEBUG) console.error(err);
    process.exit(1);
  });
