import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NearAnchor, SOCIAL_TESTNET } from '../src/anchor.js';
import { parseInstructionLocally } from '../src/agent.js';

// A fake near-api-js Account that records functionCall invocations.
function fakeAccount() {
  const calls = [];
  return {
    accountId: 'agentguard-nh.testnet',
    calls,
    async functionCall(req) {
      calls.push(req);
      return { transaction: { hash: 'FakeTxHash123' } };
    },
  };
}

test('anchor in off mode is explicit, never faked', async () => {
  const a = new NearAnchor({});
  const r = await a.anchorEntry({ seq: 1, hash: 'abc', verdict: 'APPROVED' });
  assert.equal(a.mode, 'off');
  assert.equal(r.anchored, false);
});

test('anchor writes the decision hash + verdict to NEAR Social testnet', async () => {
  const account = fakeAccount();
  const a = new NearAnchor({ account });
  assert.equal(a.mode, 'near-social');
  const entry = { seq: 7, hash: 'deadbeef'.repeat(8), verdict: 'BLOCKED', riskScore: 80, to: 'scam.testnet', amount: 45 };
  const r = await a.anchorEntry(entry);
  assert.equal(r.anchored, true);
  assert.equal(r.txHash, 'FakeTxHash123');
  assert.match(r.explorerUrl, /testnet\.nearblocks\.io\/txns\/FakeTxHash123/);
  assert.equal(account.calls.length, 1);
  const call = account.calls[0];
  assert.equal(call.contractId, SOCIAL_TESTNET);
  assert.equal(call.methodName, 'set');
  const stored = call.args.data['agentguard-nh.testnet'].agentguard.decisions[entry.hash];
  assert.ok(stored, 'decision stored under its hash');
  assert.equal(JSON.parse(stored).verdict, 'BLOCKED');
});

test('anchor failure degrades honestly instead of throwing', async () => {
  const account = { accountId: 'x.testnet', async functionCall() { throw new Error('RPC down'); } };
  const a = new NearAnchor({ account });
  const r = await a.anchorEntry({ seq: 1, hash: 'h', verdict: 'APPROVED', riskScore: 0, to: 'a.testnet', amount: 1 });
  assert.equal(r.anchored, false);
  assert.match(r.error, /RPC down/);
});

test('local instruction parser extracts amount and destination', () => {
  const p = parseInstructionLocally('Pay 12 NEAR to cloud-provider.testnet for hosting');
  assert.deepEqual({ to: p.to, amount: p.amount }, { to: 'cloud-provider.testnet', amount: 12 });
  assert.equal(parseInstructionLocally('send some money somewhere'), null);
});
