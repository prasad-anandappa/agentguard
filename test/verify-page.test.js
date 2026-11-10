// Standing gate for the /verify page (audit D0a): the page's verification
// core is extracted VERBATIM from public/verify.html and run against a
// fixture ledger produced by the real src/ledger.js. If anyone edits the
// page's chain math or record comparison so it drifts from the ledger or
// the contract again, this test fails — the page once shipped showing
// "HASH CHAIN BROKEN" + MISMATCH on a perfectly valid log because its
// private copy of the algorithm disagreed with ledger.js in three places.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger, canonicalEntry as ledgerCanonicalEntry, GENESIS_HASH as LEDGER_GENESIS } from '../src/ledger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadPageCore() {
  const html = readFileSync(path.join(ROOT, 'public', 'verify.html'), 'utf8');
  const start = html.indexOf('// === verification core');
  const end = html.indexOf('// === end verification core ===');
  assert.ok(start >= 0 && end > start, 'verify.html must carry the verification-core markers');
  const code = html.slice(start, end);
  const factory = new Function('crypto', `${code}\nreturn { canonicalEntry, verifyChain, contractRecordMatches, socialRecordMatches, GENESIS_HASH };`);
  return factory(globalThis.crypto);
}

function fixtureLedger() {
  const l = new Ledger(null);
  l.append({ agent: 'a1', proposal: { to: 'cloud-provider.testnet', amount: 12, memo: 'hosting' }, verdict: 'APPROVED', riskScore: 0, reasons: ['ok'] });
  l.append({ agent: 'a1', proposal: { to: 'cloud-provider.testnet', amount: 400, memo: 'a year upfront' }, verdict: 'BLOCKED', riskScore: 0, reasons: ['over limit'] });
  const held = l.append({ agent: 'a1', proposal: { to: 'new-vendor.testnet', amount: 30, memo: 'first month' }, verdict: 'REVIEW', riskScore: 20, reasons: ['first time'] });
  l.append({ agent: 'a1', proposal: { to: 'new-vendor.testnet', amount: 30, memo: 'first month' }, verdict: 'APPROVED', riskScore: 20, reasons: ['human approved'], kind: 'resolution', refSeq: held.seq });
  return l;
}

test('page canonicalEntry is byte-identical to ledger.js for every fixture entry', () => {
  const page = loadPageCore();
  assert.equal(page.GENESIS_HASH, LEDGER_GENESIS);
  for (const e of fixtureLedger().entries) {
    assert.equal(page.canonicalEntry(e), ledgerCanonicalEntry(e), `canonical form drifted at seq ${e.seq}`);
  }
});

test('page verifyChain confirms a ledger.js-produced chain — every entry MATCHES', async () => {
  const page = loadPageCore();
  const l = fixtureLedger();
  assert.equal(l.verifyChain().ok, true, 'fixture ledger must itself be valid');
  const perSeq = await page.verifyChain(l.entries);
  for (const e of l.entries) {
    assert.equal(perSeq.get(e.seq), true, `page chain check failed at seq ${e.seq} — the D0a bug is back`);
  }
});

test('page verifyChain still detects tampering (the MATCH above is earned)', async () => {
  const page = loadPageCore();
  const l = fixtureLedger();
  const tampered = l.entries.map((e) => ({ ...e }));
  tampered[1].amount = 401; // rewrite history: 400 -> 401
  const perSeq = await page.verifyChain(tampered);
  assert.equal(perSeq.get(tampered[1].seq), false, 'tampered entry must fail the page chain check');
});

test('page contract matcher accepts the REAL contract record shape {decision_id, verdict} — and only that', () => {
  const page = loadPageCore();
  const e = fixtureLedger().entries[1]; // BLOCKED, seq 2
  // Exactly what log.agentguard-nh.testnet's get_decision returns (live-RPC verified):
  assert.equal(page.contractRecordMatches(e, { decision_id: '2', verdict: 'BLOCKED' }), true);
  assert.equal(page.contractRecordMatches(e, { decision_id: 2, verdict: 'BLOCKED' }), true, 'numeric decision_id must also match');
  assert.equal(page.contractRecordMatches(e, { decision_id: '2', verdict: 'APPROVED' }), false);
  assert.equal(page.contractRecordMatches(e, { decision_id: '3', verdict: 'BLOCKED' }), false);
  assert.equal(page.contractRecordMatches(e, null), false);
});

test('page social matcher handles the prototype record shape (JSON string with to/amount)', () => {
  const page = loadPageCore();
  const e = fixtureLedger().entries[0]; // APPROVED 12 NEAR to cloud-provider.testnet
  const stored = JSON.stringify({ seq: e.seq, verdict: e.verdict, risk: e.riskScore, to: e.to, amount: e.amount });
  assert.equal(page.socialRecordMatches(e, stored), true);
  assert.equal(page.socialRecordMatches(e, JSON.stringify({ seq: e.seq, verdict: e.verdict, risk: 0, to: e.to, amount: 13 })), false);
  assert.equal(page.socialRecordMatches(e, null), false);
});
