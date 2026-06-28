// Generates an example spreadsheet (payouts.example.xlsx) with the expected
// shape: an "address" and an "amount" column, a couple of extra columns (to
// prove they don't break parsing), and a blank row (ignored on parse).
//
//   npm run make-example
//
// Copy it to payouts.xlsx and replace with your real recipients:
//   cp payouts.example.xlsx payouts.xlsx
import xlsx from 'xlsx';
import { getAddress } from 'viem';

const { utils, writeFile } = xlsx;

// Sample BSC addresses (checksummed). These are illustrative only.
const sample = [
  ['0x55d398326f99059ff775485246999027b3197955', 50, 'invoice #1001'],
  ['0x8894e0a0c962cb723c1976a4421c95949be2d4e3', 12.5, 'invoice #1002'],
  ['0xf977814e90da44bfa03b6295a0616a897441acec', 100, 'refback'],
  ['0x1a0a18ac4becddbd6389559687d1a73d8927e416', 7.75, ''],
  ['0x0d0707963952f2fba59dd06f2b425ace40b492fe', 250, 'partner'],
  ['0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be', 0.5, ''],
  ['0xa180fe01b906a1be37be6c534a3300785b20d947', 33.33, 'invoice #1007'],
  ['0xeb2d2f1b8c558a40207669291fda468e50c8a0bb', 18, ''],
];

const header = ['address', 'amount', 'note'];
const rows = [header];
for (const [addr, amt, note] of sample) {
  rows.push([getAddress(addr), amt, note]);
}
// Insert a fully blank row to demonstrate it is ignored.
rows.splice(4, 0, ['', '', '']);

const ws = utils.aoa_to_sheet(rows);
const wb = utils.book_new();
utils.book_append_sheet(wb, ws, 'payouts');

const out = 'payouts.example.xlsx';
writeFile(wb, out);
console.log(`Wrote ${out} with ${sample.length} recipients (+ 1 blank row).`);
console.log('Copy it to payouts.xlsx and edit:  cp payouts.example.xlsx payouts.xlsx');
