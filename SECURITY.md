# AgentGuard — Security & Threat Model

AgentGuard is a policy gate between an AI agent and its wallet. This
document states exactly what it protects, what it holds, what it cannot do,
and how it fails. If a claim here and the code disagree, the code wins —
every mechanism named below is implemented in `src/` and covered by tests
(`npm test`), and the deployed behaviour is verifiable with
`npm run verify`.

## Assets and trust boundaries

| Asset | Where it lives | Who can touch it |
|---|---|---|
| The agent's funds | The agent's own wallet / custody layer | **Never AgentGuard** (see No custody) |
| Human policy (limits, lists, budgets) | The AgentGuard service | The human operator via the UI/API |
| Decision ledger | `data/decisions.jsonl`, hash-chained, anchored on NEAR testnet | Append-only through the service; any later edit breaks the chain |
| On-chain decision records | `log.agentguard-nh.testnet` (Rust contract) | Append-only `log_decision`, callable only by the operator account |
| Operator full-access key | Developer's machine only (setup scripts) | The human operator |
| Runtime function-call key | Service environment | Scoped: one method, one contract, gas allowance only |

## Key model (boring and explicit)

- The **running service** authenticates to NEAR with a **function-call
  access key** that may call **only** `log_decision` on
  `log.agentguard-nh.testnet`, funded with a small (3 NEAR) gas allowance.
  It cannot transfer funds, add or remove keys, deploy code, or delete the
  account. Proof is on-chain in the key-creation transaction (see README).
- The **full-access key** exists only on the developer's machine and is
  used only by one-off setup scripts (`scripts/deploy-contract.mjs`,
  `scripts/setup-fc-key.mjs`). It is never present in the service
  environment, never committed, never logged.
- The **log contract** accepts writes only from its owner (the operator
  account) and exposes no update or delete method: records are append-only
  by construction, and each record is committed to the entry's SHA-256 hash.
- **Verification needs no key at all.** `scripts/anchor-check.mjs` and the
  hosted `/verify` page read public RPC data + public receipts.

## No-custody statement

AgentGuard never holds, moves, or can move funds. It returns a verdict —
`APPROVED`, `BLOCKED`, or `REVIEW` (held for a human). Executing an
approved payment is the agent's own wallet layer's job, and refusing a
non-approved one is that layer's responsibility. A policy gate that also
held the money would be a bigger target, not a safer one; the separation
is deliberate.

## Threats addressed

| Threat | Mechanism |
|---|---|
| Prompt injection plants a payment instruction in content the agent reads | Every proposal is screened before execution; scam/authority/urgency patterns, blocklist and lookalike checks fire regardless of where the instruction came from |
| Social-engineering lures (prize fees, seed-phrase phish, gift-card rake) | Memo-pattern screening with hard-block severities |
| Typosquatted / lookalike payee accounts | Edit-distance + digit-swap detection against known payees |
| Wallet drain (one big payment, or many small ones) | Per-tx + daily limits, first-time + large combo block, drain-pattern detection, velocity count + outflow caps over a rolling window |
| First payment to a fresh scam account | First-time thresholds: REVIEW above the review threshold, BLOCK above the block threshold; counterparty graduation requires consecutive clean payments |
| Payments to non-existent or unexpected contract accounts | On-chain counterparty screening (exists? contract? prior interactions?) |
| Grey-zone payments slipping through silently | Risk band 20–49 is HELD for a human decision; the resolution is itself logged and anchored |
| Repeat scam destinations | Shared blocklist with evidence reports, effective immediately |
| Silent history rewriting | SHA-256 hash chain + on-chain anchoring; `npm run verify` / `/verify` re-checks both |
| One agent's bad behaviour poisoning another's standing | Per-agent policies and per-agent reputation; counterparty trust is tracked separately |

## Failure modes (fail-visible, never fail-silent)

| Failure | Behaviour |
|---|---|
| NEAR RPC unreachable during counterparty screening | Screening reports `unavailable`, adds no findings, and the receipt records that state. The deterministic policy checks (limits, lists, patterns) still run in full. Screening absence never fabricates risk points — and never removes a hard rule. |
| Anchoring fails (RPC down, function-call key allowance exhausted) | The entry is recorded locally with the anchor error attached; the UI shows it as unanchored. Verdicts continue (the chain keeps appending), and the gap is visible — never silently dropped. |
| Webhook delivery fails (BLOCKED/REVIEW alert) | The verdict stands; the delivery receipt records the failure and the payload remains visible in the UI and the decision record. |
| Price feed unreachable (USD estimates) | Estimates render as "—". Prices are display-only and never influence a verdict. |
| Ledger file tampered with | Hash-chain verification fails at the exact entry (`npm run verify`, `/api/health`, `/verify`); on-chain records provide the reference truth. |
| Sandbox misuse | Judge sandboxes are in-memory, per-session, and anchoring-off by construction; they cannot write to the canonical ledger or spend the key's allowance. |

## Honest limitations

- **Heuristic screening.** Pattern lists catch the common lures, not every
  phrasing. That is precisely why the grey zone is held for a human instead
  of waved through, and why the limits are hard rules rather than scores.
- **The gate is only as strong as its wiring.** If an agent's wallet layer
  executes payments without asking AgentGuard — or ignores a BLOCKED
  verdict — AgentGuard cannot stop it. AgentGuard provides the checkpoint
  and the proof; the integration must route every payment through it.
- **Testnet scope.** This build is testnet-only: no real funds, and the
  operational practices (key rotation, monitoring, incident response) a
  mainnet deployment would need are out of scope and unclaimed.
- **Counterparty facts are point-in-time.** An account that is a plain
  wallet today can deploy code tomorrow; screening results are recorded
  with the decision so later reviewers see what was known when.
- **Timestamps and windows.** Velocity and budget windows use the service
  clock and recorded entry times; a host with a skewed clock weakens
  window precision (the hash chain itself is clock-independent).

## Reporting

This is a hackathon project; security reports are welcome as GitHub issues
on the repository. Please do not include real keys or credentials in a
report — testnet material only.
