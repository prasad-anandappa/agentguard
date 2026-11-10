import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, evaluateProposal } from '../src/policy.js';
import { checkCounterparty, EMPTY_CODE_HASH } from '../src/counterparty.js';
import { BlocklistStore, isValidAccountId } from '../src/blocklist.js';
import { Ledger } from '../src/ledger.js';
import { NearAnchor } from '../src/anchor.js';

const P = { ...DEFAULT_POLICY };
const fresh = { spentToday: 0, seenDestinations: new Set() };

// --- REVIEW (warn) tier -----------------------------------------------------

test('first-time payment above the review threshold is HELD for a human, not approved', () => {
  const r = evaluateProposal({ to: 'new-vendor.testnet', amount: 30, memo: 'data subscription' }, P, fresh);
  assert.equal(r.verdict, 'REVIEW');
  assert.match(r.reasons.join(' '), /human-review band/);
});

test('small first-time payment under the review threshold is still approved', () => {
  const r = evaluateProposal({ to: 'new-vendor.testnet', amount: 10, memo: 'trial credits' }, P, fresh);
  assert.equal(r.verdict, 'APPROVED');
});

test('urgency-only memo to a known payee lands in the review band', () => {
  const r = evaluateProposal(
    { to: 'cloud-provider.testnet', amount: 12, memo: 'Urgent: pay the hosting bill within 30 minutes' },
    P,
    { spentToday: 0, seenDestinations: new Set(['cloud-provider.testnet']) },
  );
  assert.equal(r.verdict, 'REVIEW');
  assert.equal(r.riskScore, 20);
});

test('hard rules still block outright instead of going to review', () => {
  const r = evaluateProposal({ to: 'near-prize-claims.testnet', amount: 30, memo: 'fee' }, P, fresh);
  assert.equal(r.verdict, 'BLOCKED');
});

// --- Counterparty screening -------------------------------------------------

function fakeProvider(behavior) {
  return { async query(req) { return behavior(req); } };
}

test('counterparty: plain wallet account produces no findings', async () => {
  const provider = fakeProvider(() => ({ amount: '1000000000000000000000000', code_hash: EMPTY_CODE_HASH, storage_usage: 1000 }));
  const cp = await checkCounterparty('someone.testnet', { provider, priorInteractions: 2 });
  assert.equal(cp.status, 'ok');
  assert.equal(cp.exists, true);
  assert.equal(cp.isContract, false);
  assert.equal(cp.findings.length, 0);
});

test('counterparty: deployed contract destination adds a risk finding', async () => {
  const provider = fakeProvider(() => ({ amount: '0', code_hash: '9p7Yd2xExampleNonEmptyCodeHashxxxxxxxxxxxx', storage_usage: 5000 }));
  const cp = await checkCounterparty('dex.testnet', { provider });
  assert.equal(cp.isContract, true);
  assert.ok(cp.findings.some((f) => f.code === 'CONTRACT_DESTINATION' && f.severity === 'risk'));
});

test('counterparty: missing account is a fact, not a failure', async () => {
  const provider = fakeProvider(() => { throw new Error('account zzz.testnet does not exist'); });
  const cp = await checkCounterparty('zzz.testnet', { provider });
  assert.equal(cp.status, 'not-found');
  assert.equal(cp.findings.length, 0);
});

test('counterparty: FastNEAR wording ("doesn\'t exist") also maps to not-found (audit D0b)', async () => {
  // The exact error FastNEAR's public RPC returns for a missing account —
  // the hosted demo runs on that endpoint, and this wording once degraded
  // every missing-account check to "unavailable".
  const provider = fakeProvider(() => { throw new Error("Can't complete the action because account cloud-provider.testnet doesn't exist"); });
  const cp = await checkCounterparty('cloud-provider.testnet', { provider });
  assert.equal(cp.status, 'not-found');
  assert.equal(cp.exists, false);
});

test('counterparty: RPC failure degrades to unavailable, never throws', async () => {
  const provider = fakeProvider(() => { throw new Error('connection reset'); });
  const cp = await checkCounterparty('x.testnet', { provider });
  assert.equal(cp.status, 'unavailable');
});

test('counterparty findings merge into policy scoring via extraFindings', () => {
  const extra = [{ code: 'CONTRACT_DESTINATION', label: 'contract', severity: 'risk', points: 15 }];
  // contract finding (15) + first-time-large (20) = 35 → review band, not a block
  const r = evaluateProposal({ to: 'new-contract.testnet', amount: 30, memo: 'swap' }, P, { ...fresh, extraFindings: extra });
  assert.equal(r.verdict, 'REVIEW');
  assert.equal(r.riskScore, 35);
});

// --- Shared blocklist ---------------------------------------------------------

test('blocklist store validates account ids and requires evidence', () => {
  const store = new BlocklistStore(null);
  assert.equal(isValidAccountId('scam.testnet'), true);
  assert.equal(isValidAccountId('not a near account'), false);
  assert.throws(() => store.add('Bad Account!', 'evidence of scam here'), /not a valid NEAR account id/);
  assert.throws(() => store.add('scam.testnet', 'short'), /evidence is required/);
});

test('a reported destination is blocked by the engine once merged into the policy', () => {
  const store = new BlocklistStore(null);
  const { added } = store.add('rug-factory.testnet', 'Took deposits, never delivered, vanished');
  assert.equal(added, true);
  const merged = { ...P, blockedDestinations: [...P.blockedDestinations, ...store.destinations()] };
  const r = evaluateProposal({ to: 'rug-factory.testnet', amount: 5, memo: 'deposit' }, merged, fresh);
  assert.equal(r.verdict, 'BLOCKED');
  // duplicate report is a no-op
  assert.equal(store.add('rug-factory.testnet', 'same scam again reported').added, false);
});

// --- Ledger: review + resolution ---------------------------------------------

test('a held decision can be resolved by a human; the chain stays valid', () => {
  const ledger = new Ledger(null);
  const held = ledger.append({ agent: 'a1', proposal: { to: 'new-vendor.testnet', amount: 30, memo: 'sub' }, verdict: 'REVIEW', riskScore: 20, reasons: ['held'] });
  assert.equal(ledger.pendingReview().length, 1);
  ledger.append({
    agent: 'a1',
    proposal: { to: held.to, amount: held.amount, memo: held.memo },
    verdict: 'APPROVED', riskScore: held.riskScore,
    reasons: [`Human approved held decision #${held.seq}`],
    kind: 'resolution', refSeq: held.seq,
  });
  assert.equal(ledger.pendingReview().length, 0);
  assert.equal(ledger.verifyChain().ok, true);
  // the approved amount counts once toward today's spend (via the resolution)
  assert.equal(ledger.spentToday(), 30);
  // reputation: 1 attempt; its final outcome is the human's approval, and
  // nothing remains held — the resolution itself is not an attempt
  const rep = ledger.reputation('a1');
  assert.equal(rep.attempts, 1);
  assert.equal(rep.held, 0);
  assert.equal(rep.approved, 1);
  assert.equal(rep.score, 100);
});

// --- Anchor: dedicated contract mode ------------------------------------------

test('anchor in dedicated mode calls log_decision on the log contract', async () => {
  const calls = [];
  const account = {
    accountId: 'agentguard-nh.testnet',
    async functionCall(req) { calls.push(req); return { transaction: { hash: 'ContractTx1' } }; },
  };
  const a = new NearAnchor({ account, dedicatedContractId: 'log.agentguard-nh.testnet' });
  assert.equal(a.mode, 'dedicated-contract');
  const r = await a.anchorEntry({ seq: 3, hash: 'cafe'.repeat(16), verdict: 'REVIEW' });
  assert.equal(r.anchored, true);
  assert.equal(r.contractId, 'log.agentguard-nh.testnet');
  assert.equal(calls[0].methodName, 'log_decision');
  assert.equal(calls[0].args.verdict, 'REVIEW');
  assert.equal(calls[0].args.decision_id, '3');
});
