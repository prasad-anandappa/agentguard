// Standing instructions (recurring payment intents).
//
// A standing instruction is screened PER OCCURRENCE against the policy and
// context in force at the moment that occurrence runs — never grandfathered
// by the verdict of an earlier occurrence. If the human tightens the policy
// on Tuesday, Wednesday's occurrence of Monday's standing instruction is
// judged by Tuesday's rules.

import { evaluateProposal } from './policy.js';

let counter = 0;

export function createStandingInstruction({ to, amount, memo = '', cadence = 'weekly' } = {}) {
  const dest = String(to || '').toLowerCase().trim();
  const amt = Number(amount);
  if (!dest) throw new Error('standing instruction needs a destination');
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('standing instruction amount must be positive');
  counter += 1;
  return {
    id: `si-${counter}`,
    to: dest,
    amount: amt,
    memo: String(memo || ''),
    cadence: String(cadence || 'weekly'),
    createdAt: new Date().toISOString(),
    occurrencesRun: 0,
  };
}

// The proposal for occurrence N (1-based). The memo records which
// occurrence it is, so the anchored ledger entry tells the whole story.
export function occurrenceProposal(si, n) {
  return {
    to: si.to,
    amount: si.amount,
    memo: `${si.memo}${si.memo ? ' ' : ''}(standing instruction ${si.id}, occurrence ${n})`,
  };
}

// Screen one occurrence against the CURRENT policy + context.
export function screenOccurrence(si, n, policy, context = {}) {
  const proposal = occurrenceProposal(si, n);
  const result = evaluateProposal(proposal, policy, context);
  return { instructionId: si.id, occurrence: n, proposal, ...result };
}
