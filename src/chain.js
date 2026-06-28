// Blockchain layer: viem clients, RPC-failover + retry, token metadata,
// balances, gas, and the actual transfer + receipt verification.
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  erc20Abi,
  decodeEventLog,
  getAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sleep } from './util.js';

const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Errors that are worth retrying (transient) vs. fatal.
const TRANSIENT_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /429/,
  /rate.?limit/i,
  /too many requests/i,
  /replacement transaction underpriced/i,
  /transaction underpriced/i,
  /nonce too low/i,
  /already known/i,
  /could not be found/i,
  /not be found/i,
  /transaction not found/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /socket hang up/i,
  /network error/i,
  /fetch failed/i,
  /503/,
  /502/,
  /bad gateway/i,
  /service unavailable/i,
  /header not found/i,
];

export function isTransient(err) {
  const msg = `${err?.shortMessage || ''} ${err?.details || ''} ${err?.message || ''} ${err?.cause?.message || ''}`;
  return TRANSIENT_PATTERNS.some((re) => re.test(msg));
}

export class Chain {
  constructor({ cfg, logger }) {
    this.cfg = cfg;
    this.logger = logger;
    this.rpcIndex = 0;
    this.chain = defineChain({
      id: cfg.chainId,
      name: `chain-${cfg.chainId}`,
      nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
      rpcUrls: { default: { http: cfg.rpcUrls } },
    });
    this.account = cfg.privateKey ? privateKeyToAccount(cfg.privateKey) : null;
    this._build();
  }

  _build() {
    const url = this.cfg.rpcUrls[this.rpcIndex];
    const transport = http(url, { timeout: 20_000, retryCount: 0 });
    this.publicClient = createPublicClient({ chain: this.chain, transport });
    this.walletClient = this.account
      ? createWalletClient({ account: this.account, chain: this.chain, transport })
      : null;
    this.activeRpc = url;
  }

  /** Switch to the next configured RPC endpoint (round-robin). */
  rotateRpc() {
    if (this.cfg.rpcUrls.length < 2) return false;
    this.rpcIndex = (this.rpcIndex + 1) % this.cfg.rpcUrls.length;
    this._build();
    this.logger?.warn(`Switched RPC endpoint -> ${this.activeRpc}`);
    return true;
  }

  /**
   * Run an async op with exponential backoff. On transient failures it retries;
   * if multiple RPCs are configured it rotates between them across attempts.
   * Fatal (non-transient) errors are thrown immediately.
   */
  async withRetry(label, fn) {
    const max = this.cfg.maxRetries;
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await fn();
      } catch (err) {
        attempt += 1;
        if (!isTransient(err) || attempt > max) throw err;
        const backoff = Math.min(1000 * 2 ** (attempt - 1), 15_000);
        this.logger?.warn(
          `${label} failed (attempt ${attempt}/${max}, transient): ${err.shortMessage || err.message}. Retrying in ${backoff}ms`,
        );
        // Rotate RPC every attempt when fallbacks exist.
        this.rotateRpc();
        await sleep(backoff);
      }
    }
  }

  // ---- reads -------------------------------------------------------------

  async readToken() {
    const [symbol, decimals] = await Promise.all([
      this.withRetry('readContract symbol', () =>
        this.publicClient.readContract({ address: this.cfg.tokenAddress, abi: erc20Abi, functionName: 'symbol' }),
      ),
      this.withRetry('readContract decimals', () =>
        this.publicClient.readContract({ address: this.cfg.tokenAddress, abi: erc20Abi, functionName: 'decimals' }),
      ),
    ]);
    return { symbol, decimals: Number(decimals) };
  }

  async tokenBalance(address) {
    return this.withRetry('balanceOf', () =>
      this.publicClient.readContract({
        address: this.cfg.tokenAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address],
      }),
    );
  }

  async nativeBalance(address) {
    return this.withRetry('getBalance', () => this.publicClient.getBalance({ address }));
  }

  async gasPrice() {
    const raw = await this.withRetry('getGasPrice', () => this.publicClient.getGasPrice());
    // Apply headroom multiplier (integer math on bigint).
    const m = this.cfg.gasPriceMultiplier;
    const scaled = (raw * BigInt(Math.round(m * 1000))) / 1000n;
    return scaled > raw ? scaled : raw;
  }

  async estimateTransferGas(to, amountWei) {
    return this.withRetry('estimateContractGas', () =>
      this.publicClient.estimateContractGas({
        address: this.cfg.tokenAddress,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [to, amountWei],
        account: this.account,
      }),
    );
  }

  async pendingNonce(address) {
    return this.withRetry('getTransactionCount(pending)', () =>
      this.publicClient.getTransactionCount({ address, blockTag: 'pending' }),
    );
  }

  // ---- write -------------------------------------------------------------

  /**
   * Broadcast a transfer with an explicit nonce + gas params and wait for the
   * receipt. Returns { hash, receipt, confirmed } where `confirmed` means the
   * receipt status is success AND a matching Transfer event was emitted.
   * Transient RPC errors are retried internally; the SAME nonce is reused so we
   * never accidentally create a gap or a duplicate at a different nonce.
   */
  async sendTransfer({ to, amountWei, nonce, gas, gasPrice }) {
    const hash = await this.withRetry('writeContract(transfer)', () =>
      this.walletClient.writeContract({
        address: this.cfg.tokenAddress,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [to, amountWei],
        nonce,
        gas,
        gasPrice,
      }),
    );

    const receipt = await this.withRetry('waitForTransactionReceipt', () =>
      this.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: 2_000 }),
    );

    const confirmed = receipt.status === 'success' && this._hasTransferEvent(receipt, to, amountWei);
    return { hash, receipt, confirmed };
  }

  /** Verify a Transfer(from=payout, to=recipient, value=amount) log exists. */
  _hasTransferEvent(receipt, to, amountWei) {
    const token = this.cfg.tokenAddress.toLowerCase();
    const from = this.account.address.toLowerCase();
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== token) continue;
      if (!log.topics || log.topics[0] !== TRANSFER_TOPIC) continue;
      try {
        const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
        if (
          ev.eventName === 'Transfer' &&
          ev.args.from.toLowerCase() === from &&
          getAddress(ev.args.to) === getAddress(to) &&
          ev.args.value === amountWei
        ) {
          return true;
        }
      } catch {
        // not decodable as Transfer; keep scanning
      }
    }
    return false;
  }
}
