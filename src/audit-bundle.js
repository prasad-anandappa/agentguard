// Audit bundle: a self-contained, self-verifying export of the decision
// ledger. The bundle carries the entries plus the chain tip, the contract
// id and explorer links, so the existing verification tooling
// (scripts/anchor-check.mjs --bundle <file>) can re-validate the hash chain
// offline and cross-check the anchored records on-chain when online.
// Tampering with any entry breaks its hash and fails verification.

import { Ledger, GENESIS_HASH } from './ledger.js';

export const BUNDLE_FORMAT = 'agentguard-audit-bundle';
export const BUNDLE_VERSION = 1;

export function buildAuditBundle(ledger, { contractId = null, operatorAccount = null, network = 'near-testnet' } = {}) {
  const entries = ledger.entries.map((e) => ({ ...e }));
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    generatedAt: new Date().toISOString(),
    network,
    contractId,
    operatorAccount,
    entryCount: entries.length,
    chainTip: entries.length ? entries[entries.length - 1].hash : GENESIS_HASH,
    chainValidAtExport: ledger.verifyChain().ok,
    explorer: {
      contract: contractId ? `https://testnet.nearblocks.io/address/${contractId}` : null,
      operator: operatorAccount ? `https://testnet.nearblocks.io/address/${operatorAccount}` : null,
    },
    entries,
  };
}

// Offline verification: format checks + full hash-chain recomputation.
export function verifyAuditBundle(bundle) {
  const errors = [];
  if (!bundle || typeof bundle !== 'object') return { ok: false, errors: ['bundle is not an object'], entryCount: 0 };
  if (bundle.format !== BUNDLE_FORMAT) errors.push(`format is "${bundle.format}", expected "${BUNDLE_FORMAT}"`);
  if (!Array.isArray(bundle.entries)) {
    errors.push('entries is not an array');
    return { ok: false, errors, entryCount: 0 };
  }
  bundle.entries.forEach((e, i) => {
    if (e.seq !== i + 1) errors.push(`entry at position ${i} has seq ${e.seq}, expected ${i + 1}`);
  });
  const { chain } = Ledger.fromEntries(bundle.entries);
  if (!chain.ok) errors.push(`hash chain broken at seq ${chain.atSeq}: ${chain.why}`);
  const tip = bundle.entries.length ? bundle.entries[bundle.entries.length - 1].hash : GENESIS_HASH;
  if (bundle.chainTip && bundle.chainTip !== tip) errors.push('chainTip does not match the last entry hash');
  if (Number.isFinite(bundle.entryCount) && bundle.entryCount !== bundle.entries.length) {
    errors.push(`entryCount ${bundle.entryCount} does not match ${bundle.entries.length} entries`);
  }
  return { ok: errors.length === 0, errors, entryCount: bundle.entries.length, chainTip: tip };
}
