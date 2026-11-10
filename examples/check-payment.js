// AgentGuard in five lines: gate any agent payment proposal before it moves.
//
//   import { checkPayment } from './examples/check-payment.js';
//   const gate = checkPayment({ to, amount, memo });
//   if (gate.allowed) await wallet.pay(to, amount);   // only APPROVED moves
//
// checkPayment wraps the real policy engine with the default policy; pass
// your own policy (and context) to match your deployment. For the auditable
// version — hash-chained log, on-chain receipts, human review queue — run
// the AgentGuard service and POST /api/propose instead.

import { evaluateProposal, DEFAULT_POLICY } from '../src/policy.js';

export function checkPayment({ to, amount, memo = '' }, policy = DEFAULT_POLICY, context = {}) {
  const { verdict, riskScore, reasons } = evaluateProposal({ to, amount, memo }, policy, context);
  return { allowed: verdict === 'APPROVED', held: verdict === 'REVIEW', verdict, riskScore, reasons };
}

// Runnable demo: `node examples/check-payment.js`
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  for (const p of [
    { to: 'cloud-provider.testnet', amount: 12, memo: 'hosting invoice #1042' },
    { to: 'near-prize-claims.testnet', amount: 45, memo: 'claim your prize — send the release fee' },
  ]) {
    const g = checkPayment(p, DEFAULT_POLICY, { seenDestinations: new Set(['cloud-provider.testnet']) });
    console.log(`${g.verdict.padEnd(8)} risk ${String(g.riskScore).padEnd(3)} pay ${p.amount} NEAR → ${p.to} — ${g.reasons[0]}`);
  }
}
