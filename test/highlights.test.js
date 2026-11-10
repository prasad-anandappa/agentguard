import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_POLICY, evaluateProposal, categoryOf } from '../src/policy.js';
import { Ledger } from '../src/ledger.js';
import { BeneficiaryStore } from '../src/beneficiaries.js';
import { createStandingInstruction, occurrenceProposal, screenOccurrence } from '../src/standing.js';
import { createPriceOracle, usdEstimate } from '../src/price.js';
import { buildAlertPayload, deliverAlert } from '../src/alerts.js';
import { buildAuditBundle, verifyAuditBundle } from '../src/audit-bundle.js';
import { replayProposal, summarizeFlips } from '../src/replay.js';
import { badgeSvg } from '../src/badge.js';
import { checkPayment } from '../examples/check-payment.js';
import { ATTACK_CHIPS } from '../src/agent.js';

const P = { ...DEFAULT_POLICY };
const fresh = { spentToday: 0, seenDestinations: new Set() };
const NOW = 1_700_000_000_000;

// --- Item 22: first-time + large combo goes straight to BLOCK ---------------

test('combo rule: first-time payment just above the block threshold is BLOCKED, not held', () => {
  const r = evaluateProposal({ to: 'new-vendor.testnet', amount: 91, memo: 'services' }, P, fresh);
  assert.equal(r.verdict, 'BLOCKED');
  assert.ok(r.findings.some((f) => f.code === 'FIRST_TIME_BLOCK'));
  assert.ok(!r.findings.some((f) => f.code === 'FIRST_TIME_LARGE'), 'combo replaces the softer finding');
});

test('combo rule boundary: exactly at the threshold stays on the REVIEW path', () => {
  const r = evaluateProposal({ to: 'new-vendor.testnet', amount: 90, memo: 'services' }, P, fresh);
  assert.equal(r.verdict, 'REVIEW');
  assert.ok(r.findings.some((f) => f.code === 'FIRST_TIME_LARGE'));
});

test('combo rule threshold is configurable', () => {
  const p = { ...P, firstTimeBlockThreshold: 50 };
  const r = evaluateProposal({ to: 'new-vendor.testnet', amount: 60, memo: 'services' }, p, fresh);
  assert.equal(r.verdict, 'BLOCKED');
});

// --- Item 13: counterparty trust graduation ---------------------------------

function trustLedger() {
  const l = new Ledger(null);
  const add = (to, verdict, kind = null, refSeq = null) => l.append({
    agent: 'a1', proposal: { to, amount: 10, memo: 'x' }, verdict, riskScore: 0, reasons: ['t'], kind, refSeq,
  });
  return { l, add };
}

test('trust: 3 consecutive clean payments graduate a counterparty', () => {
  const { l, add } = trustLedger();
  add('vendor.testnet', 'APPROVED'); add('vendor.testnet', 'APPROVED');
  assert.equal(l.counterpartyTrust(3)['vendor.testnet'].trusted, false);
  assert.equal(l.counterpartyTrust(3)['vendor.testnet'].progress, '2/3');
  add('vendor.testnet', 'APPROVED');
  const t = l.counterpartyTrust(3)['vendor.testnet'];
  assert.equal(t.trusted, true);
  assert.equal(t.progress, '3/3');
  assert.ok(l.trustedDestinations(3).has('vendor.testnet'));
});

test('trust: a BLOCK resets the streak; a pending REVIEW neither builds nor breaks it', () => {
  const { l, add } = trustLedger();
  add('vendor.testnet', 'APPROVED'); add('vendor.testnet', 'APPROVED');
  add('vendor.testnet', 'BLOCKED');
  add('vendor.testnet', 'APPROVED'); add('vendor.testnet', 'APPROVED');
  assert.equal(l.counterpartyTrust(3)['vendor.testnet'].cleanStreak, 2);
  const held = add('other.testnet', 'REVIEW');
  add('other.testnet', 'APPROVED'); add('other.testnet', 'APPROVED');
  // the held entry is still pending; streak counts only the 2 approvals
  assert.equal(l.counterpartyTrust(3)['other.testnet'].cleanStreak, 2);
  assert.ok(held.seq > 0);
});

test('trust: a graduated counterparty no longer triggers first-time findings', () => {
  const ctx = { spentToday: 0, seenDestinations: new Set(), trustedDestinations: new Set(['vendor.testnet']) };
  const r = evaluateProposal({ to: 'vendor.testnet', amount: 95, memo: 'big first order' }, P, ctx);
  assert.equal(r.verdict, 'APPROVED');
  assert.ok(!r.findings.some((f) => f.code.startsWith('FIRST_TIME')));
});

// --- Item 14: velocity / burst detection -------------------------------------

const recent = (list) => ({ spentToday: 0, seenDestinations: new Set(['burst.testnet']), recentPayments: list, now: NOW });
const pay = (to, amount, minsAgo, verdict = 'APPROVED') => ({ to, amount, ts: NOW - minsAgo * 60_000, verdict });

test('velocity: third payment to one counterparty inside the window is HELD', () => {
  const ctx = recent([pay('burst.testnet', 10, 2), pay('burst.testnet', 10, 1)]);
  const r = evaluateProposal({ to: 'burst.testnet', amount: 10, memo: 'more credits' }, P, ctx);
  assert.equal(r.verdict, 'REVIEW');
  assert.ok(r.findings.some((f) => f.code === 'VELOCITY_COUNT'));
});

test('velocity: second payment inside the window passes the count check', () => {
  const ctx = recent([pay('burst.testnet', 10, 2)]);
  const r = evaluateProposal({ to: 'burst.testnet', amount: 10, memo: 'more credits' }, P, ctx);
  assert.equal(r.verdict, 'APPROVED');
});

test('velocity window edge: a payment exactly at the window edge counts, one just outside does not', () => {
  const atEdge = recent([pay('burst.testnet', 10, 10), pay('burst.testnet', 10, 10)]);
  assert.ok(evaluateProposal({ to: 'burst.testnet', amount: 10, memo: 'x' }, P, atEdge).findings.some((f) => f.code === 'VELOCITY_COUNT'));
  const outside = recent([
    { to: 'burst.testnet', amount: 10, ts: NOW - 10 * 60_000 - 1, verdict: 'APPROVED' },
    { to: 'burst.testnet', amount: 10, ts: NOW - 10 * 60_000 - 1, verdict: 'APPROVED' },
  ]);
  assert.ok(!evaluateProposal({ to: 'burst.testnet', amount: 10, memo: 'x' }, P, outside).findings.some((f) => f.code === 'VELOCITY_COUNT'));
});

test('velocity outflow: cumulative approved outflow over the cap escalates; exactly at it does not', () => {
  const over = recent([pay('a.testnet', 100, 3), pay('b.testnet', 40, 2)]);
  const r1 = evaluateProposal({ to: 'burst.testnet', amount: 20, memo: 'x' }, P, over);
  assert.ok(r1.findings.some((f) => f.code === 'VELOCITY_OUTFLOW'));
  const atCap = recent([pay('a.testnet', 100, 3), pay('b.testnet', 40, 2)]);
  const r2 = evaluateProposal({ to: 'burst.testnet', amount: 10, memo: 'x' }, P, atCap);
  assert.ok(!r2.findings.some((f) => f.code === 'VELOCITY_OUTFLOW'));
});

test('velocity with action BLOCK hard-blocks the burst', () => {
  const p = { ...P, velocityAction: 'BLOCK' };
  const ctx = recent([pay('burst.testnet', 10, 2), pay('burst.testnet', 10, 1)]);
  const r = evaluateProposal({ to: 'burst.testnet', amount: 10, memo: 'x' }, p, ctx);
  assert.equal(r.verdict, 'BLOCKED');
});

// --- Item 23: category budgets -----------------------------------------------

test('categoryOf infers simply from the memo', () => {
  assert.equal(categoryOf('hosting invoice #9'), 'hosting');
  assert.equal(categoryOf('API data feed renewal'), 'dev');
  assert.equal(categoryOf('software license for the team'), 'tools');
  assert.equal(categoryOf('flowers for the office'), 'other');
});

test('category budget blocks when the monthly cap would be exceeded; boundary passes', () => {
  const p = { ...P, categoryBudgets: { hosting: 100, dev: 100, tools: 100, other: 100 } };
  const ctx = { spentToday: 0, seenDestinations: new Set(['cloud-provider.testnet']), spentThisMonthByCategory: { hosting: 95 } };
  const over = evaluateProposal({ to: 'cloud-provider.testnet', amount: 12, memo: 'hosting invoice' }, p, ctx);
  assert.equal(over.verdict, 'BLOCKED');
  assert.match(over.reasons.join(' '), /category/);
  const atCap = evaluateProposal({ to: 'cloud-provider.testnet', amount: 5, memo: 'hosting invoice' }, p, ctx);
  assert.notEqual(atCap.verdict, 'BLOCKED');
  const otherCat = evaluateProposal({ to: 'cloud-provider.testnet', amount: 12, memo: 'data feed' }, p, ctx);
  assert.notEqual(otherCat.verdict, 'BLOCKED');
});

// --- Item 18: beneficiary book ------------------------------------------------

test('beneficiary cap blocks above the cap and passes at it', () => {
  const ctx = { ...fresh, seenDestinations: new Set(['cloud-provider.testnet']), beneficiaryCap: 10 };
  assert.equal(evaluateProposal({ to: 'cloud-provider.testnet', amount: 12, memo: 'hosting' }, P, ctx).verdict, 'BLOCKED');
  assert.equal(evaluateProposal({ to: 'cloud-provider.testnet', amount: 10, memo: 'hosting' }, P, ctx).verdict, 'APPROVED');
});

test('a loose beneficiary cap never loosens the global limit', () => {
  const ctx = { ...fresh, beneficiaryCap: 5000 };
  const r = evaluateProposal({ to: 'cloud-provider.testnet', amount: 150, memo: 'hosting' }, P, ctx);
  assert.equal(r.verdict, 'BLOCKED');
  assert.match(r.reasons.join(' '), /per-transaction limit/);
});

test('beneficiary store validates, persists and removes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentguard-ben-'));
  const file = path.join(dir, 'beneficiaries.json');
  const s1 = new BeneficiaryStore(file);
  s1.add('Vendor.Testnet', { note: 'main host', capNear: 25 });
  assert.equal(s1.capFor('vendor.testnet'), 25);
  assert.throws(() => s1.add('bad account!', {}), /not a valid NEAR account id/);
  assert.throws(() => s1.add('ok.testnet', { capNear: -3 }), /positive number/);
  const s2 = new BeneficiaryStore(file);
  assert.equal(s2.get('vendor.testnet').note, 'main host');
  assert.equal(s2.remove('vendor.testnet'), true);
  assert.equal(s2.capFor('vendor.testnet'), null);
});

// --- Item 19: verdict trace ----------------------------------------------------

test('trace explains the verdict step by step and its points sum to the risk score', () => {
  const ok = evaluateProposal({ to: 'cloud-provider.testnet', amount: 12, memo: 'hosting invoice' }, P, { ...fresh, seenDestinations: new Set(['cloud-provider.testnet']) });
  assert.ok(Array.isArray(ok.trace));
  assert.ok(ok.trace.some((s) => s.rule === 'per-transaction-limit' && s.outcome === 'pass'));
  const scam = evaluateProposal({ to: 'rewards-desk.testnet', amount: 10, memo: 'Claim your prize now — send the release fee' }, P, fresh);
  assert.ok(scam.trace.some((s) => s.outcome === 'fired'));
  const points = scam.trace.filter((s) => Number.isFinite(s.points) && s.rule !== 'risk-score').reduce((a, s) => a + s.points, 0);
  assert.equal(points, scam.riskScore);
});

// --- Item 17: standing instructions screened per occurrence --------------------

test('standing instruction occurrences are screened against the CURRENT policy', () => {
  const si = createStandingInstruction({ to: 'api-market.testnet', amount: 30, memo: 'API data credits', cadence: 'weekly' });
  assert.match(occurrenceProposal(si, 2).memo, /occurrence 2/);
  const ctx = { spentToday: 0, seenDestinations: new Set(['api-market.testnet']) };
  assert.equal(screenOccurrence(si, 1, P, ctx).verdict, 'APPROVED');
  const tightened = { ...P, perTxLimit: 20 };
  assert.equal(screenOccurrence(si, 2, tightened, ctx).verdict, 'BLOCKED');
});

// --- Item 16: price oracle ------------------------------------------------------

test('price oracle caches, degrades to null offline, and estimates USD', async () => {
  let calls = 0;
  const oracle = createPriceOracle({
    fetchFn: async () => { calls += 1; return { ok: true, async json() { return { near: { usd: 2.5 } }; } }; },
    ttlMs: 60_000,
  });
  const p1 = await oracle.getPrice(1000);
  assert.equal(p1.usd, 2.5);
  const p2 = await oracle.getPrice(2000);
  assert.equal(p2.cached, true);
  assert.equal(calls, 1);
  const down = createPriceOracle({ fetchFn: async () => { throw new Error('offline'); } });
  assert.equal(await down.getPrice(), null);
  assert.equal(usdEstimate(12, p1), 30);
  assert.equal(usdEstimate(12, null), null);
});

// --- Item 10: alert payloads + delivery -----------------------------------------

test('alert payload carries the verdict facts; delivery is display-only without a webhook', async () => {
  const entry = { seq: 7, ts: '2026-11-10T00:00:00.000Z', agent: 'a1', to: 'x.testnet', amount: 45, verdict: 'BLOCKED', riskScore: 100, reasons: ['scam'], hash: 'abc', anchor: null };
  const payload = buildAlertPayload(entry, { contractId: 'log.agentguard-nh.testnet' });
  assert.equal(payload.event, 'agentguard.verdict');
  assert.equal(payload.alert, 'BLOCKED');
  assert.equal(payload.anchorTx, null);
  const d = await deliverAlert(payload, { url: null });
  assert.equal(d.mode, 'display-only');
  assert.equal(d.delivered, false);
});

test('alert delivery POSTs the payload when a webhook is configured; failure never throws', async () => {
  let received = null;
  const srv = createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { received = JSON.parse(b); res.writeHead(200); res.end('ok'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/hook`;
  const payload = buildAlertPayload({ seq: 1, ts: 't', agent: 'a', to: 'x.testnet', amount: 1, verdict: 'REVIEW', riskScore: 20, reasons: [], hash: 'h', anchor: null });
  const d = await deliverAlert(payload, { url });
  assert.equal(d.mode, 'posted');
  assert.equal(d.delivered, true);
  assert.equal(received.alert, 'REVIEW');
  srv.close();
  const failed = await deliverAlert(payload, { url: 'http://127.0.0.1:1/hook' });
  assert.equal(failed.mode, 'failed');
});

// --- Items 15 + 26: audit bundle verify + ledger round-trip ----------------------

test('audit bundle verifies; tampering with one entry or the tip breaks it', () => {
  const l = new Ledger(null);
  for (let i = 0; i < 3; i++) {
    l.append({ agent: 'a1', proposal: { to: 'cloud-provider.testnet', amount: 10, memo: 'hosting' }, verdict: 'APPROVED', riskScore: 0, reasons: ['ok'] });
  }
  const bundle = buildAuditBundle(l, { contractId: 'log.agentguard-nh.testnet', operatorAccount: 'agentguard-nh.testnet' });
  const okCheck = verifyAuditBundle(bundle);
  assert.equal(okCheck.ok, true);
  assert.equal(okCheck.entryCount, 3);
  const tampered = JSON.parse(JSON.stringify(bundle));
  tampered.entries[1].amount = 99999;
  const badCheck = verifyAuditBundle(tampered);
  assert.equal(badCheck.ok, false);
  assert.ok(badCheck.errors.some((e) => /hash chain/.test(e)));
  const tipTampered = JSON.parse(JSON.stringify(bundle));
  tipTampered.chainTip = 'f'.repeat(64);
  assert.equal(verifyAuditBundle(tipTampered).ok, false);
  const { ledger: restored, chain } = Ledger.fromEntries(bundle.entries);
  assert.equal(chain.ok, true);
  assert.deepEqual(restored.entries.map((e) => e.hash), l.entries.map((e) => e.hash));
});

// --- Items 12 + 21: replay + policy impact ---------------------------------------

test('replay shows then vs now; impact preview counts the flips', () => {
  const l = new Ledger(null);
  const e1 = l.append({ agent: 'a1', proposal: { to: 'cloud-provider.testnet', amount: 12, memo: 'hosting invoice' }, verdict: 'APPROVED', riskScore: 0, reasons: ['ok'] });
  l.append({ agent: 'a1', proposal: { to: 'cloud-provider.testnet', amount: 30, memo: 'hosting invoice 2' }, verdict: 'APPROVED', riskScore: 0, reasons: ['ok'] });
  const tight = { ...P, perTxLimit: 10 };
  const r = replayProposal(e1, tight, l.contextBefore(e1));
  assert.equal(r.then.verdict, 'APPROVED');
  assert.equal(r.now.verdict, 'BLOCKED');
  assert.equal(r.changed, true);
  const impact = summarizeFlips(l, l.entries, tight);
  assert.equal(impact.considered, 2);
  assert.equal(impact.flips, 2);
  // the unchanged policy reproduces history exactly — no phantom flips
  assert.equal(summarizeFlips(l, l.entries, P).flips, 0);
});

// --- Item 25: badge SVG ------------------------------------------------------------

test('badge renders the verdict with its color; unknown renders not-found', () => {
  const svg = badgeSvg({ seq: 3, verdict: 'BLOCKED', riskScore: 100 });
  assert.match(svg, /BLOCKED · risk 100/);
  assert.match(svg, /#ef4b4b/);
  assert.match(badgeSvg(null), /decision not found/);
});

// --- Item 9: SDK example -------------------------------------------------------------

test('checkPayment gates like the engine', () => {
  const okGate = checkPayment({ to: 'cloud-provider.testnet', amount: 12, memo: 'hosting' }, P, { seenDestinations: new Set(['cloud-provider.testnet']) });
  assert.equal(okGate.allowed, true);
  const scamGate = checkPayment({ to: 'near-prize-claims.testnet', amount: 45, memo: 'claim your prize' });
  assert.equal(scamGate.allowed, false);
  assert.equal(scamGate.verdict, 'BLOCKED');
  const heldGate = checkPayment({ to: 'new-vendor.testnet', amount: 30, memo: 'data subscription' });
  assert.equal(heldGate.held, true);
});

// --- Item 6: attack chips produce the advertised verdicts ------------------------------

test('attack chips: single-shot attacks are BLOCKED by the engine', () => {
  for (const chip of ATTACK_CHIPS.filter((c) => !c.times)) {
    const m = chip.instruction.match(/(\d+(?:\.\d+)?)\s*NEAR/i);
    const to = chip.instruction.match(/([a-z0-9_\-]+\.testnet)/i)[1];
    const r = evaluateProposal({ to, amount: Number(m[1]), memo: chip.instruction }, P, fresh);
    assert.equal(r.verdict, 'BLOCKED', `${chip.id} should be BLOCKED, got ${r.verdict}`);
  }
});

test('attack chips: the installments drain is caught by velocity on the third payment', () => {
  const chip = ATTACK_CHIPS.find((c) => c.id === 'installments');
  const l = new Ledger(null);
  const verdicts = [];
  for (let i = 0; i < 3; i++) {
    const ctx = {
      spentToday: l.spentToday(),
      seenDestinations: l.seenDestinations(),
      recentPayments: l.recentPayments(null, 24 * 3600_000, Date.now()),
      now: Date.now(),
    };
    const r = evaluateProposal({ to: 'fresh-vault-9281.testnet', amount: 24, memo: chip.instruction }, P, ctx);
    verdicts.push(r.verdict);
    l.append({ agent: 'a1', proposal: { to: 'fresh-vault-9281.testnet', amount: 24, memo: chip.instruction }, verdict: r.verdict, riskScore: r.riskScore, reasons: r.reasons });
  }
  assert.deepEqual(verdicts, ['APPROVED', 'APPROVED', 'REVIEW']);
});

// --- Item 3 (engine level): one guard, two agent policies ------------------------------

test('two agents, one proposal: the shopping cap blocks what the treasury policy approves', () => {
  const proposal = { to: 'api-market.testnet', amount: 60, memo: 'bulk data-credits pack' };
  const shopping = { ...P, perTxLimit: 40, dailyLimit: 120 };
  const treasury = { ...P, perTxLimit: 500, dailyLimit: 1000, firstTimeReviewThreshold: 100 };
  assert.equal(evaluateProposal(proposal, shopping, fresh).verdict, 'BLOCKED');
  assert.equal(evaluateProposal(proposal, treasury, fresh).verdict, 'APPROVED');
});

// --- Item 4 (ledger level): stats are computed, final-outcome based ----------------------

test('ledger stats count attacks stopped and NEAR protected by final outcome', () => {
  const l = new Ledger(null);
  l.append({ agent: 'a1', proposal: { to: 'x.testnet', amount: 10, memo: 'a' }, verdict: 'APPROVED', riskScore: 0, reasons: [] });
  l.append({ agent: 'a1', proposal: { to: 'y.testnet', amount: 45, memo: 'b' }, verdict: 'BLOCKED', riskScore: 90, reasons: [] });
  const held = l.append({ agent: 'a1', proposal: { to: 'z.testnet', amount: 30, memo: 'c' }, verdict: 'REVIEW', riskScore: 20, reasons: [] });
  l.append({ agent: 'a1', proposal: { to: 'z.testnet', amount: 30, memo: 'c' }, verdict: 'BLOCKED', riskScore: 20, reasons: ['denied'], kind: 'resolution', refSeq: held.seq });
  const s = l.stats();
  assert.equal(s.decisions, 3);
  assert.equal(s.attacksStopped, 2);
  assert.equal(s.nearProtected, 75);
  assert.equal(s.heldPending, 0);
  assert.equal(s.chainValid, true);
});
