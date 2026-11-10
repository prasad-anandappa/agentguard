//! AgentGuard decision-log contract (NEAR testnet).
//!
//! Stores one record per guarded agent decision: the SHA-256 hash of the
//! off-chain ledger entry, the verdict, and a decision id. Because the ledger
//! entries are hash-chained off-chain, anchoring just the hashes on-chain is
//! enough for anyone to audit the full history: recompute the chain, compare
//! hashes. The contract is deliberately minimal — a log, not a custodian. It
//! never holds or moves user funds.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::store::LookupMap;
use near_sdk::{env, near_bindgen, AccountId, PanicOnDefault};

#[near_bindgen]
#[derive(BorshDeserialize, BorshSerialize, PanicOnDefault)]
pub struct AgentGuardLog {
    owner_id: AccountId,
    /// entry_hash (hex) -> compact JSON record {decision_id, verdict}
    decisions: LookupMap<String, String>,
    total: u64,
}

#[near_bindgen]
impl AgentGuardLog {
    /// Deploy-time init. `owner_id` is the AgentGuard operator account — the
    /// only account allowed to log decisions. Taking it as a parameter (not
    /// assuming the deployer) lets the contract live on its own subaccount
    /// (e.g. log.<operator>) while the operator calls it.
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            owner_id,
            decisions: LookupMap::new(b"d"),
            total: 0,
        }
    }

    /// Record one guarded decision. Callable by the AgentGuard operator
    /// account that runs the guard service.
    pub fn log_decision(&mut self, decision_id: String, entry_hash: String, verdict: String) {
        assert_eq!(
            env::predecessor_account_id(),
            self.owner_id,
            "only the AgentGuard operator can log decisions"
        );
        let record = format!("{{\"decision_id\":\"{}\",\"verdict\":\"{}\"}}", decision_id, verdict);
        self.decisions.insert(entry_hash.clone(), record);
        self.total += 1;
        env::log_str(&format!("AG_DECISION {} {}", entry_hash, verdict));
    }

    /// Look up the on-chain record for a ledger entry hash.
    pub fn get_decision(&self, entry_hash: String) -> Option<String> {
        self.decisions.get(&entry_hash).cloned()
    }

    pub fn total_decisions(&self) -> u64 {
        self.total
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn context(predecessor: &str) {
        let mut builder = VMContextBuilder::new();
        builder.predecessor_account_id(predecessor.parse().unwrap());
        testing_env!(builder.build());
    }

    fn new_as(owner: &str) -> AgentGuardLog {
        AgentGuardLog::new(owner.parse().unwrap())
    }

    #[test]
    fn logs_and_reads_back() {
        context("agentguard-nh.testnet");
        let mut c = new_as("agentguard-nh.testnet");
        c.log_decision("1".into(), "abc123".into(), "APPROVED".into());
        c.log_decision("2".into(), "def456".into(), "BLOCKED".into());
        assert_eq!(c.total_decisions(), 2);
        let rec = c.get_decision("abc123".into()).unwrap();
        assert!(rec.contains("\"verdict\":\"APPROVED\""));
        assert!(c.get_decision("missing".into()).is_none());
    }

    #[test]
    #[should_panic(expected = "only the AgentGuard operator")]
    fn rejects_other_callers() {
        context("agentguard-nh.testnet");
        let mut c = new_as("agentguard-nh.testnet");
        context("someone-else.testnet");
        c.log_decision("3".into(), "zzz".into(), "APPROVED".into());
    }

    #[test]
    fn owner_is_the_named_operator_not_the_deployer() {
        // Contract deployed from a subaccount context: the deployer inits,
        // but only the named operator may log.
        context("log.agentguard-nh.testnet");
        let mut c = new_as("agentguard-nh.testnet");
        context("agentguard-nh.testnet");
        c.log_decision("1".into(), "abc123".into(), "REVIEW".into());
        assert_eq!(c.total_decisions(), 1);
    }
}
