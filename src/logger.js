// Per-run logger: writes timestamped lines to BOTH the console and a dedicated
// log file (one file per invocation). Never logs secrets.
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function ts() {
  return new Date().toISOString();
}

function fileStamp() {
  // 2026-06-28T15-33-07-123Z  (filesystem-safe)
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export class Logger {
  constructor({ dir = 'logs', mode = 'dry-run' } = {}) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `payout-${mode}-${fileStamp()}.log`);
    this.stream = createWriteStream(this.path, { flags: 'a' });
  }

  _write(level, msg) {
    const line = `${ts()} [${level}] ${msg}`;
    this.stream.write(line + '\n');
    return line;
  }

  info(msg) {
    console.log(this._write('INFO', msg));
  }

  warn(msg) {
    console.warn(this._write('WARN', `⚠️  ${msg}`));
  }

  error(msg) {
    console.error(this._write('ERROR', `❌ ${msg}`));
  }

  success(msg) {
    console.log(this._write('OK', `✅ ${msg}`));
  }

  /** Plain block (tables, banners) — printed verbatim, also captured to file. */
  block(text) {
    for (const l of String(text).split('\n')) this.stream.write(`${ts()} [TABLE] ${l}\n`);
    console.log(text);
  }

  async close() {
    await new Promise((res) => this.stream.end(res));
  }
}
