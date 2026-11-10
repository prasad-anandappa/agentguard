import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, evaluateProposal, screenProposal } from '../src/policy.js';

const P = { ...DEFAULT_POLICY };
const fresh = { spentToday: 0, seenDestinations: new Set() };

test('in-policy payment to a known payee is approved', () => {
  const r = evaluateProposal({ to: 'cloud-provider.testnet', amount: 12, memo: 'hosting invoice' }, P, fresh);
  assert.equal(r.verdict, 'APPROVED');
  assert.equal(r.riskScore, 0);
});

test('over per-transaction limit is blocked', () => {
  const r = evaluateProposal({ to: 'cloud-provider.testnet', amount: 400, memo: 'a year upfront' }, P, fresh);
  assert.equal(r.verdict, 'BLOCKED');
  assert.match(r.reasons.join(' '), /per-transaction limit/);
});

test('over daily limit via cumulative spend is blocked', () => {
  const r = evaluateProposal({ to: 'cloud-provider.testnet', amount: 60, memo: 'more hosting' }, P, { spentToday: 200, seenDestinations: new Set(['cloud-provider.testnet']) });
  assert.equal(r.verdict, 'BLOCKED');
  assert.match(r.reasons.join(' '), /daily limit/);
});

test('blocklisted destination is blocked', () => {
  const r = evaluateProposal({ to: 'near-prize-claims.testnet', amount: 5, memo: 'fee' }, P, fresh);
  assert.equal(r.verdict, 'BLOCKED');
  assert.match(r.reasons.join(' '), /blocklist/);
});

test('prize-claim scam memo is blocked even to a new clean-looking address', () => {
  const r = evaluateProposal({ to: 'rewards-desk.testnet', amount: 10, memo: 'Claim your prize now — send the release fee to unlock your winnings' }, P, fresh);
  assert.equal(r.verdict, 'BLOCKED');
});

test('double-your-money memo is a hard block', () => {
  const findings = screenProposal({ to: 'trading-bot.testnet', amount: 10, memo: 'guaranteed return, double your money in 7 days' }, P, fresh);
  assert.ok(findings.some((f) => f.code === 'DOUBLE_YOUR_MONEY' && f.severity === 'hard'));
});

test('seed-phrase phishing memo is a hard block', () => {
  const findings = screenProposal({ to: 'support-desk.testnet', amount: 1, memo: 'validate your wallet to continue' }, P, fresh);
  assert.ok(findings.some((f) => f.code === 'SEED_PHRASE'));
});

test('typosquat lookalike of a known payee is blocked', () => {
  const r = evaluateProposal({ to: 'cloud-providerr.testnet', amount: 12, memo: 'hosting invoice' }, P, fresh);
  assert.equal(r.verdict, 'BLOCKED');
  assert.match(r.reasons.join(' '), /looks like known payee/);
});

test('drain pattern: first-time destination taking ~all remaining daily budget is blocked', () => {
  const r = evaluateProposal({ to: 'brand-new-vendor.testnet', amount: 240, memo: 'services' }, P, fresh);
  assert.equal(r.verdict, 'BLOCKED');
});

test('allowlist mode blocks destinations not on the list', () => {
  const p = { ...P, requireAllowlist: true, allowedDestinations: ['cloud-provider.testnet'] };
  const r = evaluateProposal({ to: 'api-market.testnet', amount: 5, memo: 'credits' }, p, fresh);
  assert.equal(r.verdict, 'BLOCKED');
  assert.match(r.reasons.join(' '), /allowlist/);
});

test('risk findings accumulate and can block at threshold without a single hard rule', () => {
  // urgency (20) + authority impersonation (30) = 50 = threshold
  const r = evaluateProposal({ to: 'payments-office.testnet', amount: 10, memo: 'Urgent: the IRS requires this payment immediately' }, P, { spentToday: 0, seenDestinations: new Set(['payments-office.testnet']) });
  assert.equal(r.verdict, 'BLOCKED');
  assert.match(r.reasons.join(' '), /risk score/);
});

test('invalid proposals are blocked, never approved', () => {
  assert.equal(evaluateProposal({ to: '', amount: 10, memo: '' }, P, fresh).verdict, 'BLOCKED');
  assert.equal(evaluateProposal({ to: 'x.testnet', amount: -5, memo: '' }, P, fresh).verdict, 'BLOCKED');
  assert.equal(evaluateProposal({ to: 'x.testnet', amount: 0, memo: '' }, P, fresh).verdict, 'BLOCKED');
});
