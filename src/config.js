// Configuration assembly + validation, with hard-wired BSC defaults.
// Two sources are supported, sharing the same validation:
//   - loadConfig():  from .env (the CLI)
//   - buildConfig(): from a plain object (the desktop GUI)
// The private key is validated here and NEVER logged or persisted.
import 'dotenv/config';
import { getAddress, isAddress } from 'viem';

export const DEFAULTS = {
  tokenAddress: '0x55d398326f99059fF775485246999027B3197955',
  chainId: 56,
  explorerUrl: 'https://bscscan.com',
  expectedSymbol: 'USDT',
  expectedDecimals: 18,
  testAmount: '0.1',
  maxRetries: 5,
  gasLimitPerTx: 100000,
  gasPriceMultiplier: 1.1,
};

function toNumber(name, v, def) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
}

/** Validate a private key string; returns it normalized, or null if not provided. */
export function validatePrivateKey(pk, { required = false } = {}) {
  const v = pk == null ? '' : String(pk).trim();
  if (!v || /^0x0+$/.test(v)) {
    if (required) throw new Error('Private key is required (0x-prefixed, 64 hex characters).');
    return null;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
    throw new Error('Private key must be a 0x-prefixed 64-hex-character string.');
  }
  return v;
}

function normalizeRpcUrls(primary, fallbacks) {
  const list = [];
  if (primary && String(primary).trim()) list.push(String(primary).trim());
  const fb = Array.isArray(fallbacks)
    ? fallbacks
    : String(fallbacks || '').split(',');
  for (const f of fb) {
    const s = String(f || '').trim();
    if (s) list.push(s);
  }
  const urls = [...new Set(list)];
  if (urls.length === 0) throw new Error('At least one RPC URL is required.');
  for (const u of urls) {
    if (!/^https?:\/\//i.test(u)) throw new Error(`RPC URL must start with http(s)://  ->  "${u}"`);
  }
  return urls;
}

/**
 * Core assembler shared by loadConfig/buildConfig.
 * @param {object} src  raw values (strings/numbers) already extracted from a source
 */
function assemble(src) {
  const tokenAddress = (() => {
    const a = (src.tokenAddress && String(src.tokenAddress).trim()) || DEFAULTS.tokenAddress;
    if (!isAddress(a)) throw new Error(`Token address is not a valid address: ${a}`);
    return getAddress(a);
  })();

  const cfg = {
    tokenAddress,
    chainId: toNumber('chainId', src.chainId, DEFAULTS.chainId),
    explorerUrl: ((src.explorerUrl && String(src.explorerUrl).trim()) || DEFAULTS.explorerUrl).replace(/\/+$/, ''),
    expectedSymbol: (src.expectedSymbol && String(src.expectedSymbol).trim()) || DEFAULTS.expectedSymbol,
    expectedDecimals: toNumber('expectedDecimals', src.expectedDecimals, DEFAULTS.expectedDecimals),
    testAmount: (src.testAmount && String(src.testAmount).trim()) || DEFAULTS.testAmount,
    maxRetries: toNumber('maxRetries', src.maxRetries, DEFAULTS.maxRetries),
    gasLimitPerTx: BigInt(toNumber('gasLimitPerTx', src.gasLimitPerTx, DEFAULTS.gasLimitPerTx)),
    gasPriceMultiplier: toNumber('gasPriceMultiplier', src.gasPriceMultiplier, DEFAULTS.gasPriceMultiplier),
    rpcUrls: normalizeRpcUrls(src.rpcUrl, src.rpcFallbacks),
    privateKey: null,
  };
  return cfg;
}

/**
 * Build the runtime config from .env (CLI).
 * @param {object} opts
 * @param {boolean} opts.needsWallet  true for modes that actually send (test/execute)
 */
export function loadConfig({ needsWallet }) {
  const cfg = assemble({
    tokenAddress: process.env.TOKEN_ADDRESS,
    chainId: process.env.CHAIN_ID,
    explorerUrl: process.env.EXPLORER_URL,
    expectedSymbol: process.env.EXPECTED_SYMBOL,
    expectedDecimals: process.env.EXPECTED_DECIMALS,
    testAmount: process.env.TEST_AMOUNT,
    maxRetries: process.env.MAX_RETRIES,
    gasLimitPerTx: process.env.GAS_LIMIT_PER_TX,
    gasPriceMultiplier: process.env.GAS_PRICE_MULTIPLIER,
    rpcUrl: process.env.RPC_URL,
    rpcFallbacks: process.env.RPC_FALLBACKS,
  });
  cfg.privateKey = validatePrivateKey(process.env.PRIVATE_KEY, { required: needsWallet });
  return cfg;
}

/**
 * Build the runtime config from a plain object (desktop GUI). The private key,
 * if supplied, is validated but the caller decides when to attach it (the GUI
 * unlocks separately and never persists it).
 * @param {object} input
 */
export function buildConfig(input = {}) {
  const cfg = assemble(input);
  if (input.privateKey != null && input.privateKey !== '') {
    cfg.privateKey = validatePrivateKey(input.privateKey, { required: false });
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
