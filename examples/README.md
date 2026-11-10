# Use AgentGuard with your agent

Two integration depths:

## 1. In-process gate (this folder)

```js
import { checkPayment } from './examples/check-payment.js';

const gate = checkPayment({ to, amount, memo });   // your agent's proposal
if (gate.allowed) await wallet.pay(to, amount);     // APPROVED → execute
else if (gate.held) await humanReview(gate);        // REVIEW → ask a human
else logBlocked(gate);                              // BLOCKED → never execute
```

`checkPayment` runs the same deterministic policy engine the service uses —
limits, blocklist, scam screening, typosquat, first-time, drain, velocity
and category rules — with a verdict, a 0–100 risk score, human-readable
reasons, and (from `evaluateProposal` directly) a step-by-step rule trace.

## 2. Service gate (auditable)

Run the AgentGuard server (`npm start`) and gate through the API:

```bash
curl -X POST localhost:8787/api/propose \
  -H 'Content-Type: application/json' \
  -d '{"instruction":"Pay 12 NEAR to cloud-provider.testnet for hosting"}'
```

Every decision is appended to the SHA-256 hash-chained ledger and anchored
to NEAR testnet through the project's log contract; held payments wait in
the review inbox for a human; blocked and held verdicts fire the alert
webhook. Verify the whole history any time with `npm run verify` or the
hosted [/verify](https://agentguard.nammaprojects.com/verify) page.
