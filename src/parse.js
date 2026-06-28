// Parse + validate the payouts spreadsheet. Validation runs on EVERY row BEFORE
// anything is sent; all errors are collected so a dirty file is rejected whole.
//
// The header row is auto-detected (a title/banner row above the real headers is
// skipped), column names are matched in English AND Ukrainian/Russian, and the
// first sheet that actually contains an address+amount header is used.
import { readFileSync } from 'node:fs';
import xlsx from 'xlsx';
import { isAddress, getAddress } from 'viem';
import { parseAmount } from './util.js';

const { read, utils } = xlsx;

// Header matchers (case-insensitive, substring). NOTE: "usdt" is deliberately
// NOT an amount alias — it commonly appears inside a wallet column header like
// "Гаманець (USDT BEP20)", which must match the ADDRESS column, not amount.
const ADDR_RE = /address|wallet|recipient|\bto\b|гаман|адрес|кошел|получ/i;
const AMT_RE = /amount|value|\bsum\b|сум|кільк|количест/i;
const MAX_HEADER_SCAN = 25; // rows to scan for the header before giving up

/** Find the header row + address/amount columns within one sheet's matrix. */
function detectHeader(matrix) {
  const limit = Math.min(MAX_HEADER_SCAN, matrix.length);
  for (let r = 0; r < limit; r++) {
    const row = matrix[r] || [];
    let addrCol = -1;
    for (let c = 0; c < row.length; c++) {
      const h = String(row[c] ?? '').trim();
      if (h && ADDR_RE.test(h)) { addrCol = c; break; }
    }
    if (addrCol === -1) continue;
    let amtCol = -1;
    for (let c = 0; c < row.length; c++) {
      if (c === addrCol) continue;
      const h = String(row[c] ?? '').trim();
      if (h && AMT_RE.test(h)) { amtCol = c; break; }
    }
    if (amtCol !== -1) {
      return { headerRowIdx: r, addrCol, amtCol, addrHeader: String(row[addrCol]).trim(), amtHeader: String(row[amtCol]).trim() };
    }
  }
  return null;
}

/**
 * @returns {{
 *   recipients: Array<{row:number,address:string,wei:bigint,human:string,raw:string}>,
 *   errors: Array<{row:number,address:string,amount:string,reason:string}>,
 *   duplicates: Array<{address:string,rows:number[]}>,
 *   sheetName: string, headerRow: number, addrHeader: string, amtHeader: string,
 * }}
 */
export function parsePayouts(filePath, decimals) {
  const buf = readFileSync(filePath);
  const wb = read(buf, { type: 'buffer' });
  if (!wb.SheetNames.length) throw new Error('Workbook has no sheets');

  // Use the first sheet that actually has an address + amount header.
  let chosen = null;
  for (const name of wb.SheetNames) {
    const matrix = utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '', blankrows: false });
    if (!matrix.length) continue;
    const det = detectHeader(matrix);
    if (det) { chosen = { name, matrix, ...det }; break; }
  }
  if (!chosen) {
    throw new Error(
      `Could not find a header row with an address column (e.g. "address"/"wallet"/"Гаманець") and an amount column (e.g. "amount"/"Сума") in any sheet. Sheets checked: [${wb.SheetNames.join(', ')}].`,
    );
  }

  const { name: sheetName, matrix, headerRowIdx, addrCol, amtCol, addrHeader, amtHeader } = chosen;

  const recipients = [];
  const errors = [];
  const ignored = []; // non-recipient rows (totals/section labels) — reported, not sent
  const seen = new Map(); // checksummed address -> [rowNumbers]

  for (let r = headerRowIdx + 1; r < matrix.length; r++) {
    const rowArr = matrix[r] || [];
    const rowNum = r + 1; // 1-based, matches the spreadsheet row numbering
    const rawAddr = String(rowArr[addrCol] ?? '').trim();
    const rawAmt = rowArr[amtCol];

    const amtEmpty = rawAmt === '' || rawAmt === null || rawAmt === undefined;
    // Fully empty row -> ignore silently.
    if (rawAddr === '' && amtEmpty) continue;

    // A non-empty address cell with no "0x" at all is not a payable address —
    // it's a totals/section label (e.g. "РАЗОМ", "TOTAL"). Skip it but REPORT it
    // (transparent, never sent), instead of failing the whole file. Anything
    // that looks like a real (but broken) address still errors below.
    if (rawAddr !== '' && !/0x/i.test(rawAddr)) {
      ignored.push({ row: rowNum, value: rawAddr });
      continue;
    }

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

  return { recipients, errors, duplicates, ignored, sheetName, headerRow: headerRowIdx + 1, addrHeader, amtHeader };
}
