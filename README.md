# AgentGuard

**AI agents can hold wallets and move money. Who stops them when they're tricked, buggy, or pointed at the wrong account?**

AgentGuard is a safety layer that sits between an AI agent and its wallet. Every payment the agent proposes is checked against human-set rules *before* it can move — and every decision, **APPROVED**, **BLOCKED**, or **HELD for human review**, is written to a tamper-evident log anchored on NEAR (testnet), in a **dedicated Rust smart contract** built for this project.

Built for the [NEAR Hackathon — "Build Beyond Boundaries"](https://nearhackathon.com/) · Tracks: **Agents** + **Security** · Testnet only.

## Live

| | |
|---|---|
| **Live demo** | https://agentguard.nammaprojects.com *(deployed and running on the project server; public as soon as the DNS record propagates — until then, run it locally, see Quickstart)* |
| **Decision-log contract** | [`log.agentguard-nh.testnet`](https://testnet.nearblocks.io/address/log.agentguard-nh.testnet) — Rust / near-sdk, owner-gated, append-only |
| **Operator account** | [`agentguard-nh.testnet`](https://testnet.nearblocks.io/address/agentguard-nh.testnet) |
| **Verify the demo decisions** | `npm run anchor-check` — keyless, see below |

The canonical verdicts, anchored through the contract:

| Verdict | On-chain proof (testnet) |
|---|---|
| ✅ **APPROVED** — 12 NEAR hosting bill, in-policy, risk 0 | [tx 2EMUtLLy…KVpNTv](https://testnet.nearblocks.io/txns/2EMUtLLyxtSAAp79vCqrsLXFmzzShfibpKskBGKVpNTv) |
| ⛔ **BLOCKED** — 400 NEAR, over the 100 NEAR per-transaction limit | [tx BYonzu2b…wheJE12](https://testnet.nearblocks.io/txns/BYonzu2bTGKKH1mGs8BjmyU6mLjY5ncoTcm9jwheJE12) |
| ⛔ **BLOCKED** — 45 NEAR "prize release fee", scam risk 100 | [tx Fc22c8fg…JiSsHt](https://testnet.nearblocks.io/txns/Fc22c8fgXxFcuSQ4xUYgR4s8BgmFCpYX9YLmoKJiSsHt) |
| ⏸ **HELD → human approved** — 30 NEAR first payment to a new vendor, risk 20 | [held](https://testnet.nearblocks.io/txns/DW3vBNbGh7ezJUhEpgRnSEjBnkVBFB1PykiwKZ8XTFnt) · [resolution](https://testnet.nearblocks.io/txns/7Rfm5dzABv9MEZmkoFoL6UPkjAeiBTjbtCi11oqyJgf4) |

## Screenshots

| Policy, templates & scenarios | ✅ Approved (12 NEAR) |
|---|---|
| ![Policy panel, templates and demo scenarios](docs/demo-assets/01-policy-and-scenarios.png) | ![Approved verdict card](docs/demo-assets/02-verdict-approved-12near.png) |
| ⛔ **Blocked — over limit (400 NEAR)** | ⛔ **Blocked — prize scam (45 NEAR, risk 100)** |
| ![Blocked over-limit verdict card](docs/demo-assets/03-verdict-blocked-400near-overlimit.png) | ![Blocked scam verdict card](docs/demo-assets/04-verdict-blocked-45near-scam.png) |
| ⏸ **Held for review → human approved** | **Decision log with explorer links** |
| ![Review resolution card](docs/demo-assets/05-review-resolution.png) | ![Decision log](docs/demo-assets/06-decision-log.png) |

## The problem

Agent frameworks now give AI agents real wallets. That's powerful — and dangerous in ways a normal payment app never faces:

- **Scams aimed at the agent.** A fake "you won a prize, send a release fee" message that a human would laugh at can talk an agent into paying.
- **Prompt injection.** Text the agent reads (a web page, an invoice note, a chat message) can smuggle in payment instructions.
- **Fat-finger / hallucination damage.** One misread digit or a wrong-but-similar account name (`cloud-provider` vs `cloud-prov1der`) and funds are gone — blockchain transfers don't have an undo button.
- **No audit trail.** When something goes wrong, "the agent decided" is not an answer. Teams need a record they can trust and show.

AgentGuard is the checkpoint every agent payment has to pass — and the receipt that proves what happened.

## How AgentGuard maps to the brief

**Agents track** — *"prove a stranger can use it: clear README, a demo, visible receipts"*:
- The demo page lists every payment instruction it ran; each decision links to its NEAR testnet transaction in an explorer.
- Every run produces a receipt: verdict, risk score, reasons, ledger hash, on-chain anchor.

**Security track** — *"make the key handling boring and explicit"*:
- AgentGuard **never holds the money** and never holds a full-access key at runtime. Its chain credential is a **function-call access key scoped to one method (`log_decision`) on one contract**, with a small gas allowance — it cannot transfer funds, add keys, or deploy code (see [Key model](#key-model)).
- The harmful action each feature prevents is stated next to it in [What it checks](#what-it-checks).

## What it does

1. **A human sets the rules** — per-transaction limit, daily limit, review threshold, allowlist/blocklist, or a one-click policy template (Conservative / Demo standard / Commerce).
2. **The agent proposes a payment** in plain language ("Pay 12 NEAR to cloud-provider.testnet for this month's hosting invoice"). NEAR AI Cloud inference parses it when a key is configured; a deterministic local parser does the same job offline, so the demo runs anywhere.
3. **AgentGuard evaluates** the proposal against the policy, scam intelligence, an on-chain counterparty check, and the agent's own history (see checks below).
4. **Verdict:** `APPROVED` (clean), `BLOCKED` (a hard rule or clear scam signal fired), or `REVIEW` (in between — held until a human approves or denies it in the UI; the resolution is logged too).
5. **The decision is appended to a SHA-256 hash-chained ledger and anchored on NEAR testnet** through the project's own contract, so anyone can verify later that the record wasn't rewritten.

## What it checks

Each check names the attack or accident it exists to stop:

| Check | Prevents |
|---|---|
| Per-transaction & daily limits | A tricked or buggy agent draining the wallet in one go |
| Blocklist (built-in + community reports) | Repeat payments to known scam destinations |
| Scam-pattern screening of the memo/instruction (prize lures, "release fee", seed-phrase requests, urgency pressure, authority impersonation) | Social-engineering and prompt-injection text that talks the agent into paying |
| Typosquat / lookalike detection (edit distance + digit-for-letter swaps vs known-good accounts) | Funds sent to `cloud-prov1der.testnet` instead of `cloud-provider.testnet` |
| First-time-destination & drain-pattern detection | A fresh scam account receiving its first payment; many small payments sneaking under the per-tx limit |
| **On-chain counterparty screening** (keyless RPC: does the account exist? is it a contract? have we paid it before?) | Payments to non-existent accounts (burned funds) and to unexpected **contract** destinations — a classic drainer pattern (+risk) |
| Risk score 0–100 with three verdict bands | Grey-zone payments silently passing: band 20–49 is HELD for a human, exactly as the brief's "asks a human when it's warn" requires |

Plus: a **shared blocklist** anyone can report into *with evidence* (reports take effect immediately and are listed in the UI), **per-agent reputation** derived from the ledger (approvals / blocks / holds per agent), and a downloadable **audit report** (Markdown: policy, counts, reputation, the full hash-chained log with explorer links).

## Key model

Boring and explicit, per the security brief:

- The **agent's wallet is never touched by AgentGuard** — in a production wiring the agent (or its custody layer) executes only `APPROVED` verdicts; AgentGuard's decision is the gate.
- The **operator account** (`agentguard-nh.testnet`, testnet) is controlled by a full-access key used only by one-off setup scripts (`scripts/deploy-contract.mjs`, `scripts/setup-fc-key.mjs`) on the developer's machine.
- The **running service** authenticates with a **function-call access key**:
  - may call **only** `log_decision` on `log.agentguard-nh.testnet`,
  - carries a **3 NEAR allowance** that pays its own gas — when it runs out, anchoring stops (fail-visible, never fail-silent) until the operator rotates the key,
  - **cannot** transfer NEAR, add/remove keys, deploy code, or delete the account.
  - Proof: [key-creation tx 4p5mMDW1…Db2WgJnn](https://testnet.nearblocks.io/txns/4p5mMDW16zFGnqynRq7mjqk2aH7oHPkQXYvzDb2WgJnn) — the access-key permission is visible in the transaction.
- The **log contract** accepts `log_decision` only from its owner (the operator account), and its records are append-only — no update or delete method exists.
- **Verification needs no key at all**: `scripts/anchor-check.mjs` reads public RPC data + public transaction receipts.

## The Rust contract

[`contract/`](contract/) — `log.agentguard-nh.testnet`, deployed 2026-11-10:

- deploy tx: [FkuoTLTm…Ws1W437uoX](https://testnet.nearblocks.io/txns/FkuoTLTmsZDhMG9X3y8j4o4w85KKx1GNnaWs1W437uoX) · init tx: [J4NUZxJJ…36ZMQ4sPuF](https://testnet.nearblocks.io/txns/J4NUZxJJWaeUhKcNdjQdZwJhiJdRPdYm1E36ZMQ4sPuF)
- `log_decision(agent, destination, amount, verdict, risk_score, entry_hash)` — owner-only, append-only, emits an `AGENTGUARD_DECISION` log line per record.
- `get_decision(index)` / `total_decisions()` / `owner()` — public views; `npm run anchor-check` cross-checks both the views and the transaction receipts against the local ledger.
- Built + unit-tested (3 tests) in CI on every push; the same pipeline produces the deployable wasm artifact.

## Quickstart

```bash
git clone https://github.com/prasad-anandappa/agentguard && cd agentguard
npm install
npm start          # → http://localhost:8787
```

No keys needed: without a `.env`, AgentGuard runs fully locally and marks entries "local only" — nothing is faked. Click the four scenarios; the 4th is **held for review** — approve or deny it in the card that appears.

To anchor live (testnet): copy `.env.example` to `.env`, create a testnet account, run `node scripts/deploy-contract.mjs` + `node scripts/setup-fc-key.mjs`, and restart. Or point it at the already-deployed contract above.

## Verify it yourself (no keys, no trust)

```bash
npm run anchor-check
```

Recomputes the local hash chain, then for every anchored entry fetches the public transaction and — for contract anchors — the contract's own stored record, comparing verdicts. Sample output from the canonical log:

```
Hash chain: VALID (5 entries)
#1 APPROVED — on-chain verdict (dedicated-contract): APPROVED · tx success: true · MATCH ✓
#2 BLOCKED — on-chain verdict (dedicated-contract): BLOCKED · tx success: true · MATCH ✓
#3 BLOCKED — on-chain verdict (dedicated-contract): BLOCKED · tx success: true · MATCH ✓
#4 REVIEW — on-chain verdict (dedicated-contract): REVIEW · tx success: true · MATCH ✓
#5 APPROVED — on-chain verdict (dedicated-contract): APPROVED · tx success: true · MATCH ✓
ALL ANCHORED ENTRIES VERIFIED ON-CHAIN ✓
```

Earlier demo decisions were anchored through the NEAR Social testnet contract (`v1.social08.testnet`) before the dedicated contract existed — those transactions remain valid proof of the same ledger hashes: [APPROVED](https://testnet.nearblocks.io/txns/H4YrhT7HCvh3uW5xim3qLnNbhb8QjEBG6pAMeUr9JX5e) · [BLOCKED 400](https://testnet.nearblocks.io/txns/8CffrpEAKY31EtfE5TuSjLfewvgWik1CgsuF11hBnE8w) · [BLOCKED scam](https://testnet.nearblocks.io/txns/EL7imtfi2KTisL5vu63UZtZxuqgGLfkN4BSSRHU5Kehn).

## Attack demo

```bash
npm run attack-demo   # boots a throwaway instance — your real log is untouched
```

Runs three scripted prompt-injection attacks end-to-end — a fake "NEAR Foundation security team" authority lure, a typosquat of a known-good payee, and a sub-limit drain sequence — and shows all three stopped (2 BLOCKED, 1 HELD). Exit code 0 only if every attack is stopped.

## Tests & CI

```bash
npm test    # 35 tests: policy engine, ledger hash-chain, REVIEW flow,
            # counterparty screening, shared blocklist, reputation, server API
```

GitHub Actions (`.github/workflows/ci.yml`) runs the Node suite + attack demo, the contract's Rust unit tests, and the wasm build on every push.

## Honest scope & limits

- **Testnet only.** No real funds are involved anywhere in this project, and nothing here is a mainnet safety product (yet).
- **AgentGuard gates; it doesn't hold keys to the money.** Executing (or refusing) an approved payment stays with the agent's own wallet/custody layer — by design; a policy engine that also held the funds would be a bigger target, not a safer one.
- **Scam screening is heuristic.** Pattern lists catch the common lures, not every possible phrasing; that's why grey-zone scores are held for a human instead of waved through.
- **Counterparty screening degrades gracefully.** If the RPC is unreachable, screening reports "unavailable" and never blocks on missing data.
- **NEAR AI Cloud inference is optional.** The verdict path is deterministic policy code; the LLM (when configured) only parses the instruction into `{to, amount, memo}`.
- The seeded demo log ships in `data/decisions.jsonl`; bot
...[truncated 2085 chars]