# AgentGuard log contract (optional dedicated deployment)

A minimal NEAR contract that records AgentGuard decision hashes on-chain:
`log_decision(decision_id, entry_hash, verdict)`, `get_decision(entry_hash)`,
`total_decisions()`. Only the operator account that deployed it can write.

**How the live demo anchors today:** the app's anchor module
(`../src/anchor.js`) writes each decision hash to NEAR testnet via the NEAR
Social testnet contract (`v1.social08.testnet`, method `set`) — real,
explorer-verifiable testnet transactions with zero deployment needed. If this
dedicated contract is deployed, set `AGENTGUARD_CONTRACT_ID` in the
environment and the same module calls `log_decision` on it instead. The data
recorded is identical either way.

## Build & deploy (testnet)

Prereqs: Rust + `cargo-near` (https://github.com/near/cargo-near), and a funded
testnet account (free from the testnet faucet / wallet).

```sh
cd contract
cargo near build
# deploy to a sub-account of your testnet account, then initialise:
near deploy <contract.account.testnet> target/near/agentguard_log.wasm new '{}'
```

Note: the hackathon demo environment used for the submission run did not have
a Rust toolchain available, so the shipped demo anchors through NEAR Social
(see above) and this contract is provided as the dedicated-deployment source.
Its unit tests (`cargo test`) cover logging, read-back, and the
operator-only write rule.
