import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Ledger, hashEntry } from '../src/ledger.js';

function fill(n) {
  const l = new Ledger();
  for (let i = 0; i < n; i++) {
    l.append({
      agent: 'a1',
      proposal: { to: 'cloud-provider.testnet', amount: 10, memo: 'invoice' },
      verdict: i % 3 === 2 ? 'BLOCKED' : 'APPROVED',
      riskScore: 0,
      reasons: ['ok'],
    });
  }
  return l;
}

test('hash chain verifies for an untouched ledger', () => {
  const l = fill(5);
  assert.equal(l.verifyChain().ok, true);
});

test('tampering with an entry breaks the chain', () => {
  const l = fill(4);
  l.entries[1].amount = 99999; // simulate a later edit of history
  const v = l.verifyChain();
  assert.equal(v.ok, false);
  assert.equal(v.atSeq, 2);
});

test('each entry hash commits to its content', () => {
  const l = fill(1);
  const e = l.entries[0];
  assert.equal(hashEntry(e), e.hash);
  assert.equal(e.prevHash, '0'.repeat(64));
});

test('spentToday counts only approved entries', () => {
  const l = fill(3); // 2 approved x 10, 1 blocked
  assert.equal(l.spentToday(), 20);
});

test('anchors persist across a reload (regression: anchor was lost on restart)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentguard-ledger-'));
  const file = path.join(dir, 'decisions.jsonl');
  const l1 = new Ledger(file);
  const e = l1.append({
    agent: 'a1',
    proposal: { to: 'cloud-provider.testnet', amount: 10, memo: 'invoice' },
    verdict: 'APPROVED', riskScore: 0, reasons: ['ok'],
  });
  l1.setAnchor(e.seq, { anchored: true, txHash: 'TxABC', explorerUrl: 'https://testnet.nearblocks.io/txns/TxABC' });
  const l2 = new Ledger(file);
  assert.equal(l2.entries[0].anchor.txHash, 'TxABC');
  assert.equal(l2.verifyChain().ok, true);
});

test('reputation reflects the anchored history', () => {
  const l = fill(3);
  const rep = l.reputation('a1');
  assert.equal(rep.attempts, 3);
  assert.equal(rep.approved, 2);
  assert.equal(rep.blocked, 1);
  assert.equal(rep.score, 67);
  assert.equal(rep.tier, 'WATCHED');
  assert.equal(l.reputation('nobody').score, null);
});
