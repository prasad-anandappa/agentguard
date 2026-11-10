// Decision replay — audit time-travel.
//
// Re-evaluates a historical ledger entry's proposal against a given
// (typically the CURRENT) policy, holding the world constant: the context
// is reconstructed as it stood just before the original decision (see
// Ledger.contextBefore), so the POLICY is the only variable that moves.
// Under the unchanged policy, replay reproduces the original verdict.
// Replay never writes to the ledger and never anchors.

import { evaluateProposal } from './policy.js';

const freshContext = () => ({
  spentToday: 0, seenDestinations: new Set(), trustedDestinations: new Set(),
  recentPayments: [], extraFindings: [],
});

export function replayProposal(entry, policy, context = freshContext()) {
  const result = evaluateProposal(
    { to: entry.to, amount: entry.amount, memo: entry.memo },
    policy,
    context,
  );
  return {
    seq: entry.seq,
    then: { verdict: entry.verdict, riskScore: entry.riskScore, reasons: entry.reasons },
    now: { verdict: result.verdict, riskScore: result.riskScore, reasons: result.reasons, trace: result.trace },
    changed: result.verdict !== entry.verdict,
  };
}

// Policy impact preview: how many of the given entries would flip verdict
// under a candidate policy (contexts reconstructed per entry).
export function summarizeFlips(ledger, entries, policy) {
  const details = [];
  let considered = 0;
  for (const e of entries) {
    if (e.kind === 'resolution') continue;
    considered += 1;
    const r = replayProposal(e, policy, ledger.contextBefore(e, policy.graduationThreshold ?? 3));
    if (r.changed) details.push({ seq: e.seq, fromVerdict: e.verdict, toVerdict: r.now.verdict, destination: e.to, amount: e.amount });
  }
  return { considered, flips: details.length, details };
}
