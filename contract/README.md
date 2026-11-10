# AgentGuard log contract — DEPLOYED

A minimal NEAR contract that records AgentGuard decisions on-chain.
**Live on testnet:** [`log.agentguard-nh.testnet`](https://testnet.nearblocks.io/address/log.agentguard-nh.testnet)
(deploy tx [FkuoTLTm…](https://testnet.nearblocks.io/txns/FkuoTLTmsZDhMG9X3y8j4o4w85KKx1GNnaWs1W437uoX),
init tx [J4NUZxJJ…](https://testnet.nearblocks.io/txns/J4NUZxJJWaeUhKcNdjQdZwJhiJdRPdYm1E36ZMQ4sPuF)).

Interface:

- `log_decision(agent, destination, amount, verdict, risk_score, entry_hash)` → index.
  Owner-only (`agentguard-nh.testnet`), append-only — there is no update or
  delete method. Emits an `AGENTGUARD_DECISION` log line per record.
- `get_decision(index)` → the stored record · `total_decisions()` · `owner()`.

The app's anchor module (`../src/anchor.js`) calls `log_decision` whenever
`AGENTGUARD_CONTRACT_ID` is set (it is, in the live demo), authenticating with
a **function-call access key scoped to this one method** — see the main
README's "Key model". Without the variable it falls back to anchoring via
the NEAR Social testnet contract (`v1.social08.testnet` `set`), which the
earliest demo decisions used; `npm run anchor-check` verifies both modes.

## Build

CI (`.github/workflows/ci.yml`) runs `cargo test` (3 unit tests: logging,
read-back, non-owner rejection) and builds the wasm on every push, publishing
it as the `agentguard-log-wasm` artifact. Locally:

```sh
cd contract
rustup target add wasm32-unknown-unknown
cargo test
cargo build --target wasm32-unknown-unknown --release
# wasm: target/wasm32-unknown-unknown/release/agentguard_log.wasm
```

(`near-sdk` is pinned to `=5.1.0` — the contract targets that `#[near_bindgen]`
API; a floating `5.x` resolves to newer SDKs whose `#[near]` macro style this
code predates.)

## Deploy (testnet)

```sh
node scripts/deploy-contract.mjs   # creates log.<operator>.testnet if needed,
                                   # deploys, initialises new(owner = operator)
node scripts/setup-fc-key.mjs      # mints the scoped function-call key the
                                   # app anchors with
```

Then set `AGENTGUARD_CONTRACT_ID=log.<operator>.testnet` and point
`NEAR_TESTNET_CREDENTIALS` at the function-call key file. Done — the running
service never holds a full-access key.
