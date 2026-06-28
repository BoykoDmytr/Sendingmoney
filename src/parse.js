// Parse + validate payouts.xlsx. Validation runs on EVERY row BEFORE anything
// is sent; all errors are collected so a dirty file is rejected wholesale.
import { readFileSync } from 'node:fs';
import xlsx from 'xlsx';
import { isAddress, getAddress } from 'viem';
import { parseAmount } from './util.js';

const { read, utils } = xlsx;

function findHeader(headerRow, candidates) {
  for (let i = 0; i < headerRow.length; i++) {
    const h = String(headerRow[i] ?? '').trim().toLowerCase();
    if (candidates.includes(h)) return i;
  }
  return -1;
}

/**
 * @returns {{
 *   recipients: Array<{row:number,address:string,wei:bigint,human:string,raw:string}>,
 *   errors: Array<{row:number,address:string,amount:string,reason:string}>,
 *   duplicates: Array<{address:string,rows:number[]}>,
 * }}
 */
export function parsePayouts(filePath, decimals) {
  const buf = readFileSync(filePath);
  const wb = read(buf, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('Workbook has no sheets');
  const sheet = wb.Sheets[sheetName];

  // header:1 => array-of-arrays. raw:true keeps numbers as numbers so we can
  // detect/parse precisely; defval keeps column alignment for sparse rows.
  const matrix = utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', blankrows: false });
  if (matrix.length === 0) throw new Error('Sheet is empty');

  const headerRow = matrix[0];
  const addrCol = findHeader(headerRow, ['address', 'wallet', 'to', 'recipient']);
  const amtCol = findHeader(headerRow, ['amount', 'value', 'usdt', 'sum']);
  if (addrCol === -1 || amtCol === -1) {
    throw new Error(
      `Could not find required headers. Expected an "address" and an "amount" column. Got: [${headerRow.join(', ')}]`,
    );
  }

  const recipients = [];
  const errors = [];
  const seen = new Map(); // checksummed address -> [rowNumbers]

  for (let r = 1; r < matrix.length; r++) {
    const rowArr = matrix[r];
    const rowNum = r + 1; // 1-based, matches spreadsheet row numbering
    const rawAddr = String(rowArr[addrCol] ?? '').trim();
    const rawAmt = rowArr[amtCol];

    const amtEmpty = rawAmt === '' || rawAmt === null || rawAmt === undefined;
    // Fully empty row -> ignore silently.
    if (rawAddr === '' && amtEmpty) continue;

    let problem = null;
    let checksummed = rawAddr;
    let parsed = null;

    if (rawAddr === '') {
      problem = 'address is empty';
    } else if (!isAddress(rawAddr)) {
      problem = 'address is not a valid EVM address';
    } else {
      checksummed = getAddress(rawAddr); // normalize to checksum form
    }

    if (!problem) {
      try {
        parsed = parseAmount(rawAmt, decimals);
      } catch (e) {
        problem = e.message;
      }
    }

    if (problem) {
      errors.push({ row: rowNum, address: rawAddr, amount: String(rawAmt ?? ''), reason: problem });
      continue;
    }

    const key = checksummed;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(rowNum);

    recipients.push({
      row: rowNum,
      address: checksummed,
      wei: parsed.wei,
      human: parsed.human,
      raw: String(rawAmt),
    });
  }

  const duplicates = [];
  for (const [address, rows] of seen) {
    if (rows.length > 1) duplicates.push({ address, rows });
  }

  return { recipients, errors, duplicates };
}
