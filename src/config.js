// Loads and validates configuration from .env (with hard-wired BSC defaults).
// The private key is read here and NEVER logged or persisted anywhere.
import 'dotenv/config';
import { getAddress, isAddress } from 'viem';

function reqEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return String(v).trim();
}

function num(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got "${v}"`);
  return n;
}

/**
 * Build the runtime config.
 * @param {object} opts
 * @param {boolean} opts.needsWallet  true for modes that actually send (test/execute)
 */
export function loadConfig({ needsWallet }) {
  const cfg = {
    tokenAddress: (() => {
      const a = process.env.TOKEN_ADDRESS?.trim() || '0x55d398326f99059fF775485246999027B3197955';
      if (!isAddress(a)) throw new Error(`TOKEN_ADDRESS is not a valid address: ${a}`);
      return getAddress(a);
    })(),
    chainId: num('CHAIN_ID', 56),
    explorerUrl: (process.env.EXPLORER_URL?.trim() || 'https://bscscan.com').replace(/\/+$/, ''),
    expectedSymbol: process.env.EXPECTED_SYMBOL?.trim() || 'USDT',
    expectedDecimals: num('EXPECTED_DECIMALS', 18),
    testAmount: process.env.TEST_AMOUNT?.trim() || '0.1',
    maxRetries: num('MAX_RETRIES', 5),
    gasLimitPerTx: BigInt(num('GAS_LIMIT_PER_TX', 100000)),
    gasPriceMultiplier: num('GAS_PRICE_MULTIPLIER', 1.1),
    rpcUrls: [],
    privateKey: null,
  };

  // RPC endpoints (primary + optional fallbacks), de-duplicated, order preserved.
  const rpcs = [process.env.RPC_URL?.trim()].filter(Boolean);
  const fallbacks = (process.env.RPC_FALLBACKS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  cfg.rpcUrls = [...new Set([...rpcs, ...fallbacks])];
  if (cfg.rpcUrls.length === 0) {
    throw new Error('Missing RPC_URL. Set a (preferably private) BSC RPC endpoint in .env.');
  }

  // Load the key when present (so dry-run can show real balances), but only
  // *require* it for modes that actually send.
  const pk = process.env.PRIVATE_KEY?.trim();
  if (pk && !/^0x0+$/.test(pk)) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
      throw new Error('PRIVATE_KEY must be a 0x-prefixed 64-hex-character string.');
    }
    cfg.privateKey = pk;
  } else if (needsWallet) {
    if (!pk) reqEnv('PRIVATE_KEY'); // throws the standard "missing" message
    throw new Error('PRIVATE_KEY is all zeros (the placeholder). Set a real payout key in .env.');
  }

  return cfg;
}

/** A redacted view of config safe to print/log (no secrets). */
export function redactedConfig(cfg) {
  return {
    tokenAddress: cfg.tokenAddress,
    chainId: cfg.chainId,
    explorerUrl: cfg.explorerUrl,
    expectedSymbol: cfg.expectedSymbol,
    expectedDecimals: cfg.expectedDecimals,
    testAmount: cfg.testAmount,
    maxRetries: cfg.maxRetries,
    rpcCount: cfg.rpcUrls.length,
    walletLoaded: Boolean(cfg.privateKey),
  };
}
