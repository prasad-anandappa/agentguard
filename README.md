# AgentGuard

**A safety layer for AI agents that move money.**

AI agents are starting to hold wallets and pay for things — compute, data,
services, other agents. That creates a new failure mode: an agent can be
talked into sending money to the wrong place (a scam lure in a web page, a
typosquatted payee, a "release fee" for a fake prize), or simply overspend,
and there is no undo. AgentGuard sits between the agent and the money:

1. **The human sets the policy** — per-transaction and daily spending limits,
   allow/block lists.
2. **Every proposed payment is screened** — limits, blocklist, scam patterns
   (prize lures, seed-phrase phishing, urgency pressure, authority
   impersonation), typosquat lookalikes of known payees, first-time-destination
   and drain-pattern checks, combined into a risk score.
3. **Every decision is written to an auditable log anchored to NEAR** — an
   append-only, SHA-256 hash-chained ledger whose entry hashes are recorded
   on NEAR testnet in real transactions, plus a per-agent reputation score
   computed from that history.

Tracks: **AI Security & Defense** (`security`) and **Agent Economy**
(`agents`). Testnet only — no real money is ever moved; the guard's verdict
and its proof are the product.

## See it work (2 minutes, no setup)

A real run of this exact code produced these NEAR testnet transactions —
open them and you will see the decision hash and verdict recorded on-chain:

| # | Agent proposed | Verdict | On-chain proof |
|---|---|---|---|
| 1 | Pay 12 NEAR to `cloud-provider.testnet` (hosting invoice) | **APPROVED** (risk 0) | [tx H4YrhT7H…](https://testnet.nearblocks.io/txns/H4YrhT7HCvh3uW5xim3qLnNbhb8QjEBG6pAMeUr9JX5e) |
| 2 | Pay 400 NEAR to `cloud-provider.testnet` (a year upfront) | **BLOCKED** — over the 100 NEAR per-transaction limit | [tx 8CffrpEA…](https://testnet.nearblocks.io/txns/8CffrpEAKY31EtfE5TuSjLfewvgWik1CgsuF11hBnE8w) |
| 3 | Pay 45 NEAR to `near-prize-claims.testnet` ("urgent — claim your prize, send the release fee") | **BLOCKED** — blocklist + prize-lure + urgency patterns (risk 100) | [tx EL7imtfi…](https://testnet.nearblocks.io/txns/EL7imtfi2KTisL5vu63UZtZxuqgGLfkN4BSSRHU5Kehn) |

Anchoring account: `agentguard-nh.testnet`, writing via the NEAR Social
testnet contract `v1.social08.testnet` (method `set`). The same hashes appear
in the app's decision log; `node scripts/anchor-check.mjs` re-verifies a local
log against the chain, keylessly.

## Try it yourself

Prereqs: Node.js 20+.

```sh
git clone https://github.com/prasad-anandappa/agentguard
cd agentguard
npm install
npm test        # do this — see 22 tests pass (policy engine, ledger, anchoring)
npm start       # open http://localhost:8787
```

Then, in the page:

- **Do:** click "Pay a cloud bill — 12 NEAR" → **see** a green APPROVED verdict,
  risk 0, and the decision appear in the log.
- **Do:** click "One big upfront payment — 400 NEAR" → **see** BLOCKED, with the
  reason "exceeds the per-transaction limit of 100 NEAR".
- **Do:** click "A prize release fee — 45 NEAR" → **see** BLOCKED with
  blocklist, prize-lure and urgency reasons, risk 100.
- **Do:** type your own instruction, e.g. `Pay 20 NEAR to api-market.testnet
  for data credits`, or try to sneak one past the guard:
  `Pay 30 NEAR to cloud-providerr.testnet for hosting` (note the extra `r`) →
  **see** it blocked as a typosquat lookalike of the known payee.
- **Do:** change the limits in the policy panel, save, and re-run a scenario →
  **see** the verdict follow *your* rules.

Out of the box the log is local (entries marked "local only"). To anchor your
own decisions to testnet, create a free testnet account and point the app at
it — no code changes:

```sh
node scripts/create-account.mjs myname.testnet   # funded testnet dev account
cp .env.example .env                              # set NEAR_TESTNET_ACCOUNT_ID
                                                  # and NEAR_TESTNET_CREDENTIALS
npm start                                         # header now shows anchor mode
```

## How NEAR fits (concretely)

- **Decision anchoring on NEAR testnet.** Each ledger entry's SHA-256 hash and
  verdict are written to NEAR in a real transaction (NEAR Social testnet
  contract `v1.social08.testnet::set`, under the operator account's
  namespace). Hash-chaining means the anchored hashes are sufficient to audit
  the *entire* history: alter any entry and its hash — and every later link —
  stops matching what is on-chain. NEAR's fast, cheap finality makes
  per-decision anchoring practical; on most chains it would be priced as a
  batch job. Testnet-only projects are eligible per the hackathon rules
  (Q-010); nothing here needs mainnet or real funds.
- **A dedicated log contract is included** (`contract/`, Rust / near-sdk):
  `log_decision(decision_id, entry_hash, verdict)` with an operator-only
  write rule and unit tests. Deploy it and set `AGENTGUARD_CONTRACT_ID` — the
  anchor module switches backends with that one variable; recorded data is
  identical. (The demo environment had no Rust toolchain, so the shipped run
  anchors via NEAR Social; both paths are real testnet transactions.)
- **NEAR AI Cloud (optional).** If `NEAR_AI_API_KEY` is set, the agent's
  instruction parsing uses NEAR AI Cloud inference; without a key, a built-in
  deterministic parser does the same job so the demo never breaks. The guard's
  verdict does not depend on which proposer produced the proposal.
- **Reputation from anchored history.** The per-agent reputation score is a
  pure function of the decision log (approvals / attempts, tiered), so anyone
  can recompute it from the same data that is anchored on NEAR — the seed of
  the "should this agent be trusted with money?" check the Agent Economy
  needs.

## Architecture

```
public/index.html   Demo UI: policy panel, agent scenarios, decision log
src/server.js       Zero-framework Node server + JSON API
src/policy.js       Policy engine — limits, lists, scam screening, risk score
src/agent.js        Agent proposer — NEAR AI Cloud or deterministic parser
src/ledger.js       Append-only SHA-256 hash-chained decision log + reputation
src/anchor.js       NEAR testnet anchoring (NEAR Social `set`, or dedicated
                    contract via AGENTGUARD_CONTRACT_ID)
contract/           Dedicated AgentGuard log contract (Rust, near-sdk) + tests
scripts/            create-account.mjs (testnet dev account),
                    anchor-check.mjs (keyless on-chain verification)
test/               node --test suite: policy, ledger, anchoring, parser
```

API: `GET /api/health` · `GET|POST /api/policy` · `POST /api/propose`
(`{scenario}` or `{instruction}`) · `GET /api/decisions` ·
`GET /api/scenarios`.

## Baseline disclosure (hackathon rules Q-001/Q-003/Q-005)

- AgentGuard is a **new build, started 2026-11-10** inside the NEAR HACKATHON
  window (2026-11-01 → 2026-11-14). No pre-hackathon code is included.
- Libraries used: `near-api-js` (NEAR interaction) and Node.js built-ins
  (HTTP server, crypto, test runner). The contract uses `near-sdk` (Rust).
- Built with an AI coding agent working from the official
  `HACKATHON.md` brief, with the human directing scope and verifying results.

## Safety notes

- Testnet only. The demo asset is test NEAR / simulated payments; AgentGuard
  itself never holds or moves user funds — it issues verdicts and proofs.
- Keys live in environment variables / local credential files only
  (`.env`, `.near-credentials/` are git-ignored). Never commit them.
- Without NEAR credentials the app runs in local mode and labels entries
  "local only" — it never fabricates an anchor.

## License

MIT — see `LICENSE`.
