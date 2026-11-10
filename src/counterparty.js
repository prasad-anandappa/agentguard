// On-chain counterparty screening.
//
// Before the guard scores a proposal, it asks NEAR testnet about the
// destination account itself — the counterparty signals the AI Security
// track brief names: does the account exist, is it a deployed smart
// contract (code hash differs from the empty-account default), what does
// it hold, and have we interacted with it before (from the local ledger).
//
// Design rule: this check informs the verdict, it must never break it.
// Any RPC failure degrades to status 'unavailable' with no findings, and
// a missing/demo account is reported as a fact (status 'not-found'),
// not a block — the policy engine's own rules decide what blocks.

export const EMPTY_CODE_HASH = '11111111111111111111111111111111';

function yoctoToNear(yocto) {
  try {
    return Number(BigInt(yocto) / 10n ** 22n) / 100; // ~2dp, display-grade
  } catch {
    return null;
  }
}

// provider: anything with an async query() matching near-api-js JsonRpcProvider
// (a fake in tests). priorInteractions: number of past ledger entries to `to`.
export async function checkCounterparty(to, { provider, priorInteractions = 0 } = {}) {
  const base = { account: to, priorInteractions };
  if (!provider) return { ...base, status: 'unavailable', findings: [] };
  let acct;
  try {
    acct = await provider.query({
      request_type: 'view_account',
      finality: 'final',
      account_id: to,
    });
  } catch (e) {
    const msg = String(e.message || e);
    // Provider wordings differ: near.org says "does not exist", FastNEAR
    // says "doesn't exist" — both must map to not-found, not unavailable.
    if (/does ?n['’]?t exist|does not exist|not exist|unknown account/i.test(msg)) {
      return { ...base, status: 'not-found', exists: false, findings: [] };
    }
    return { ...base, status: 'unavailable', findings: [] };
  }
  const isContract = Boolean(acct.code_hash && acct.code_hash !== EMPTY_CODE_HASH);
  const findings = [];
  if (isContract) {
    findings.push({
      code: 'CONTRACT_DESTINATION',
      label: `Destination ${to} is a deployed smart contract, not a plain wallet — contract interactions need extra care`,
      severity: 'risk',
      points: 15,
    });
  }
  return {
    ...base,
    status: 'ok',
    exists: true,
    isContract,
    balanceNear: yoctoToNear(acct.amount),
    storageUsage: acct.storage_usage,
    findings,
  };
}

// Race a promise against a timeout so a slow RPC can never stall a decision.
export function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}
