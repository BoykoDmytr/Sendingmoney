# USDT (BEP-20) Batch Payout CLI

A production-ready command-line tool for distributing **USDT (BEP-20) on BNB Smart
Chain** to a list of recipients from an Excel file.

This tool moves **real money**. It is built so that the *default* action is to do
nothing dangerous: it validates everything first, runs a pre-flight balance/gas
check, requires an explicit confirmation, and keeps an idempotent ledger so a
crash or a `Ctrl+C` can be safely resumed **without double-paying anyone**.

> ⚠️ **USDT on BSC has 18 decimals, not 6.** Unlike USDT on Ethereum/Tron, the BSC
> contract (`0x55d398326f99059fF775485246999027B3197955`) uses 18 decimals. This
> tool never hard-codes decimals — it reads `symbol`/`decimals` **on-chain** and
> refuses to run if they don't match the expected values (wrong-contract guard).

---

## Safety model (read this first)

| Guard | Behavior |
| --- | --- |
| **Dry-run by default** | With no mode flag, nothing is ever sent. Real sends require `--execute` (or `--test`). |
| **Validate-then-send** | Every row is validated *before* the first transaction. One bad row ⇒ the whole run is rejected with a table of problems. |
| **On-chain token check** | `symbol`/`decimals` are read from the contract; a mismatch with `EXPECTED_SYMBOL`/`EXPECTED_DECIMALS` aborts the run. |
| **Pre-flight** | Checks the payout wallet holds enough USDT for the total and enough BNB for gas; otherwise stops and tells you how much to top up. |
| **Explicit confirmation** | Real sends need a typed `YES` (or `--yes` for automation). |
| **Idempotent ledger** | A SQLite ledger keyed by `(run_id, address)` skips anyone already paid. Re-running resumes from where it stopped. |
| **Receipt-verified success** | A payment counts as success only when the receipt `status === success` **and** a matching `Transfer` event is present — not the function return value. |
| **Kill switch** | `Ctrl+C` finishes the in-flight transaction, records it, and exits cleanly so the ledger stays consistent. |
| **Secrets stay secret** | The private key is read only from `.env`, never logged or written anywhere. `.env`, logs, the DB and spreadsheets are git-ignored. |

---

## Requirements

- Node.js ≥ 20
- A funded payout wallet (USDT for the payments + a little BNB for gas)
- A BSC RPC endpoint — a **private/paid** one is strongly recommended (public
  endpoints rate-limit hard on 200–300 sequential sends + receipt polling)

## Install

```bash
npm install
cp .env.example .env      # then edit .env (PRIVATE_KEY, RPC_URL, ...)
```

## Configure (`.env`)

| Key | Default | Notes |
| --- | --- | --- |
| `PRIVATE_KEY` | — | Dedicated payout wallet key. **Required for `--test`/`--execute`.** Never commit it. |
| `RPC_URL` | — | Primary BSC RPC (private recommended). |
| `RPC_FALLBACKS` | — | Optional comma-separated fallback RPCs; rotated on rate-limit/timeout. |
| `TOKEN_ADDRESS` | `0x55d3…7955` | USDT BEP-20. |
| `CHAIN_ID` | `56` | BNB Smart Chain. |
| `EXPLORER_URL` | `https://bscscan.com` | Used to build tx links. |
| `EXPECTED_SYMBOL` / `EXPECTED_DECIMALS` | `USDT` / `18` | Wrong-contract guard. |
| `TEST_AMOUNT` | `0.1` | Amount sent to each address in `--test` mode. |
| `MAX_RETRIES` | `5` | Retries for transient RPC errors. |
| `GAS_LIMIT_PER_TX` | `100000` | Generous fixed gas limit (unused gas is refunded). |
| `GAS_PRICE_MULTIPLIER` | `1.1` | Headroom over the network gas price. |

## Input file (`payouts.xlsx`)

First row is headers. Required columns: **`address`** and **`amount`** (extra
columns like `note` are ignored; blank rows are ignored).

| address | amount | note |
| --- | --- | --- |
| 0x8894…D4E3 | 12.5 | invoice #1002 |
| 0xF977…aceC | 100 | refback |

Generate a ready-made example to copy from:

```bash
npm run make-example          # writes payouts.example.xlsx
cp payouts.example.xlsx payouts.xlsx
```

---

## Usage — run it in this order

### 1. Dry-run (default) — validate + plan, send nothing

```bash
node src/cli.js --dry-run --file payouts.xlsx
# or simply:  npm run payout
```

Prints the validated plan, the pre-flight summary (balances, total, gas budget)
and stops. **No transactions.** Fix any reported problems before continuing.

### 2. Test — send `TEST_AMOUNT` to every real address (cheap end-to-end check)

```bash
node src/cli.js --test --file payouts.xlsx
```

Sends `TEST_AMOUNT` (e.g. `0.1 USDT`) to **each** address using a **separate
ledger**, so you can confirm the whole pipeline works against the real recipient
list for a few dollars before the real distribution.

### 3. Execute — the real distribution

```bash
node src/cli.js --execute --file payouts.xlsx
```

Runs pre-flight, asks you to type `YES`, then pays the real amounts sequentially.
At the end it writes **`results.xlsx`** (the receipt) and prints a summary of
succeeded / failed / skipped, total USDT sent and gas used. Any failures are
listed separately — **just re-run the same command to retry only those** (paid
addresses are skipped automatically).

### Options

```
--dry-run            Validate + plan, no sends (default).
--test               Send TEST_AMOUNT to every address (isolated ledger).
--execute            Send the real amounts.
--file <path>        Input spreadsheet (default: payouts.xlsx).
--yes                Skip the interactive YES confirmation (automation).
--stop-on-error      Halt on the first failed transfer instead of continuing.
--duplicates <mode>  Duplicate addresses: "reject" (default) or "sum".
--help               Show help.
```

---

## How resume / idempotency works

Each run gets a deterministic `run_id` derived from the recipient list + token +
chain + mode. Before sending to an address the tool checks the ledger; if that
address already has a **success** row for this `run_id`, it is skipped. So:

- A crash, RPC outage or `Ctrl+C` partway through is safe — re-run the same
  command and it continues from the next unpaid address.
- Failed (reverted / not-confirmed) addresses are **not** marked paid, so a
  re-run retries them.
- `--test` and `--execute` use different `run_id` namespaces, so a test run never
  marks anyone as "paid" for the real run.

## Handling the edge cases

- **Duplicate addresses** — detected and reported; choose `--duplicates sum` to
  add their amounts or `reject` (default) to stop. Interactively you'll be asked.
- **Too many decimals / zero / empty / non-numeric amounts** — rejected during
  validation with the exact row number.
- **Wrong checksum** — a mixed-case address with a bad checksum is rejected;
  valid addresses are normalized to checksum form.
- **RPC down / rate-limited mid-run** — transient errors (timeout, 429,
  `replacement underpriced`, `nonce too low`, …) are retried with exponential
  backoff and the endpoint is rotated if `RPC_FALLBACKS` is set.
- **Not enough BNB / USDT** — caught in pre-flight before anything is sent; for
  BNB it tells you how much to add.
- **Nonce drift** — sending uses a manual nonce starting from the wallet's
  pending nonce; after an un-broadcast failure the nonce is re-synced from the
  node.

## Output & logging

- **Console + log file** — every run writes a timestamped log to `logs/`
  (`payout-<mode>-<timestamp>.log`) with recipient, amount, tx hash, explorer
  link and status.
- **`results.xlsx`** (`results-test.xlsx` for test mode) — address, amount,
  status, tx_hash, explorer link, gas used, error, timestamp. Use it for
  refback accounting.

## Project structure

```
src/
  cli.js        Entry point + argument parsing + orchestration (the safety order).
  config.js     Loads/validates .env with BSC defaults; never logs the key.
  parse.js      Reads the .xlsx and validates EVERY row (collects all errors).
  chain.js      viem clients, RPC failover + retry, token reads, send + receipt verify.
  preflight.js  Balance/gas checks and the pre-flight summary.
  ledger.js     SQLite idempotency ledger + deterministic run_id.
  payout.js     Sequential, idempotent, manual-nonce send engine + kill switch.
  report.js     results.xlsx exporter.
  logger.js     Per-run file + console logger.
  util.js       Decimal-safe amount parsing and table rendering.
scripts/
  make-example.js   Generates payouts.example.xlsx.
test/
  offline.test.mjs  No-network tests (precision, validation, dupes, ledger). `npm test`.
```

## Testing

```bash
npm test     # offline suite: amount precision, validation, duplicates, ledger idempotency
```

## Security notes

- The **private key** is read only from `.env` (git-ignored) and is never logged,
  printed or written to the ledger/results. Use a **dedicated** payout wallet
  that holds only the funds for this distribution.
- `.gitignore` excludes `.env`, `*.log`, the SQLite DB, `payouts.xlsx` and
  `results*.xlsx` so recipient data and secrets are never committed.
- **Dependency advisories:** `npm audit` reports issues in `xlsx` (SheetJS) and a
  transitive `ws` (via `viem`). In this tool the spreadsheet is your own local,
  trusted file and the RPC transport is HTTP-only (the vulnerable `ws` WebSocket
  path is unused), so the practical risk is low. If your policy requires a clean
  audit, install SheetJS from its official CDN build
  (`npm i https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`).
- Always do `--dry-run`, then `--test`, then `--execute`.
