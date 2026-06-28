// Export the ledger rows for a run into results.xlsx — the receipt used for
// refback accounting.
import xlsx from 'xlsx';

const { utils, writeFile } = xlsx;

export function exportResults({ ledger, runId, cfg, outPath }) {
  const rows = ledger.rowsForRun(runId);
  const data = rows.map((r) => ({
    address: r.address,
    amount: r.amount_human,
    status: r.status,
    tx_hash: r.tx_hash || '',
    explorer: r.tx_hash ? `${cfg.explorerUrl}/tx/${r.tx_hash}` : '',
    gas_used: r.gas_used || '',
    error: r.error || '',
    timestamp: new Date(r.ts).toISOString(),
  }));

  const ws = utils.json_to_sheet(data, {
    header: ['address', 'amount', 'status', 'tx_hash', 'explorer', 'gas_used', 'error', 'timestamp'],
  });
  const wb = utils.book_new();
  utils.book_append_sheet(wb, ws, 'results');
  writeFile(wb, outPath);
  return { outPath, count: data.length };
}
