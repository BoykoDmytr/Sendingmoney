// Offline test suite — no network. Exercises the safety-critical pure logic:
// amount precision, row validation, duplicate detection and ledger idempotency.
//
//   npm test
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import xlsx from 'xlsx';
import { getAddress } from 'viem';
import { parsePayouts } from '../src/parse.js';
import { parseAmount } from '../src/util.js';
import { Ledger, deriveRunId, STATUS } from '../src/ledger.js';

const { utils, writeFile } = xlsx;
const DEC = 18;
const TOKEN = '0x55d398326f99059fF775485246999027B3197955';
const tmp = (n) => join(tmpdir(), n);

let pass = 0;
let fail = 0;
const ok = (c, m) => {
  if (c) { pass++; console.log('  ✅', m); }
  else { fail++; console.log('  ❌', m); }
};
const writeSheet = (rows, path) => {
  const ws = utils.aoa_to_sheet(rows);
  const wb = utils.book_new();
  utils.book_append_sheet(wb, ws, 'p');
  writeFile(wb, path);
  return path;
};

console.log('\n# amount precision & validation (18-decimal token)');
ok(parseAmount('0.1', 18).wei === 100000000000000000n, '0.1 -> 1e17 wei');
ok(parseAmount(50, 18).wei === 50000000000000000000n, 'number 50 -> 5e19 wei');
ok(parseAmount('33.33', 18).human === '33.33', '33.33 stays exact');
ok(parseAmount('1.123456', 18).wei === 1123456000000000000n, '6 decimals fine on 18-dec token');
for (const [v, label] of [['0', 'zero'], ['-5', 'negative'], ['1,000', 'comma'], ['abc', 'non-numeric'], ['1.' + '1'.repeat(19), '19 decimals']]) {
  try { parseAmount(v, 18); ok(false, `${label} rejected`); } catch { ok(true, `${label} rejected`); }
}

console.log('\n# parse + validate: good file (blank row ignored, extra column tolerated)');
{
  const p = writeSheet([
    ['address', 'amount', 'note'],
    [getAddress('0x8894e0a0c962cb723c1976a4421c95949be2d4e3'), 12.5, 'a'],
    ['', '', ''],
    [getAddress('0xf977814e90da44bfa03b6295a0616a897441acec'), 100, 'b'],
  ], tmp('good.xlsx'));
  const { recipients, errors, duplicates } = parsePayouts(p, DEC);
  ok(recipients.length === 2 && errors.length === 0 && duplicates.length === 0, '2 valid, 0 errors, 0 dupes');
  ok(recipients[0].wei === 12500000000000000000n, 'amount -> wei');
}

console.log('\n# parse + validate: dirty file collects ALL errors, sends nothing');
{
  const p = writeSheet([
    ['address', 'amount'],
    ['0xnot_an_address', 5],
    [getAddress('0x8894e0a0c962cb723c1976a4421c95949be2d4e3'), -1],
    ['0x8894E0A0C962cb723C1976a4421c95949bE2D4E3', 0], // bad checksum + zero
    [getAddress('0xf977814e90da44bfa03b6295a0616a897441acec'), 'xyz'],
  ], tmp('dirty.xlsx'));
  const { recipients, errors } = parsePayouts(p, DEC);
  ok(recipients.length === 0 && errors.length === 4, 'all 4 bad rows reported, 0 valid');
}

console.log('\n# duplicate detection (case-insensitive)');
{
  const a = getAddress('0x8894e0a0c962cb723c1976a4421c95949be2d4e3');
  const p = writeSheet([['address', 'amount'], [a, 10], [a.toLowerCase(), 5], [getAddress('0xf977814e90da44bfa03b6295a0616a897441acec'), 1]], tmp('dupe.xlsx'));
  const { duplicates } = parsePayouts(p, DEC);
  ok(duplicates.length === 1 && duplicates[0].rows.length === 2, '1 dup across 2 rows');
}

console.log('\n# real-world format: title row + Ukrainian headers + totals row');
{
  const a1 = getAddress('0x80f779833ae323defbd5917a85cbe5df96532278');
  const a2 = getAddress('0x583bd313d279872cc672330255ce84b606dd0201');
  const a3 = getAddress('0xbee19486e8567c2bafe576cc5554f156ecff3783');
  const p = writeSheet([
    ['CRYPTO HORNET  ·  Рефбек 01.06.2026', '', '', ''], // banner/title row (skipped)
    ['№', 'Гаманець (USDT BEP20)', 'Сума, USDT', 'Статус'], // real headers on row 2
    [1, a1, 847.9162, 'виплачено'],
    [2, a2, 420.1763, 'виплачено'],
    [3, a3, 360.8781, 'виплачено'],
    ['', 'РАЗОМ', 1628.9706, ''], // totals row (ignored, not an error)
  ], tmp('refback.xlsx'));
  const { recipients, errors, ignored, addrHeader, amtHeader, headerRow } = parsePayouts(p, DEC);
  ok(headerRow === 2, 'header row auto-detected below the banner (row 2)');
  ok(addrHeader.includes('Гаманець') && amtHeader.includes('Сума'), 'Ukrainian address/amount columns matched');
  ok(recipients.length === 3 && errors.length === 0, '3 recipients, 0 errors');
  ok(new Set(recipients.map((r) => r.human)).size === 3, 'amounts are distinct per recipient');
  ok(recipients[0].wei === 847916200000000000000n, '847.9162 -> wei (18 decimals, distinct amount)');
  ok(ignored.length === 1 && ignored[0].value === 'РАЗОМ', 'totals row ("РАЗОМ") ignored, not errored');
}

console.log('\n# ledger idempotency / resume');
{
  const path = tmp('ledger-test.sqlite');
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(path + ext, { force: true }); } catch {} }
  const recips = [
    { address: getAddress('0x8894e0a0c962cb723c1976a4421c95949be2d4e3'), human: '10' },
    { address: getAddress('0xf977814e90da44bfa03b6295a0616a897441acec'), human: '20' },
  ];
  const id = (mode, list = recips) => deriveRunId({ recipients: list, tokenAddress: TOKEN, chainId: 56, mode, testAmount: '0.1' });
  ok(id('execute') === id('execute', [...recips].reverse()), 'run_id is order-independent');
  ok(id('execute') !== id('test'), 'test mode has its own ledger namespace');

  const runId = id('execute');
  const led = new Ledger(path);
  ok(led.isPaid(runId, recips[0].address) === false, 'not paid initially');
  led.record({ runId, address: recips[0].address, amountWei: 10n, amountHuman: '10', status: STATUS.SUCCESS, txHash: '0xabc', now: Date.now() });
  led.close();

  const led2 = new Ledger(path); // simulate restart
  ok(led2.isPaid(runId, recips[0].address) === true, 'still paid after reopen (resume)');
  ok(led2.isPaid(runId, recips[1].address) === false, '2nd recipient pending (resume continues)');
  led2.record({ runId, address: recips[1].address, amountWei: 20n, amountHuman: '20', status: STATUS.FAILED, error: 'boom', now: Date.now() });
  ok(led2.isPaid(runId, recips[1].address) === false, 'failed is retryable (not skipped)');
  led2.close();
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
