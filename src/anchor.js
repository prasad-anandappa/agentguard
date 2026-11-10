// NEAR testnet anchoring for AgentGuard decision hashes.
//
// Each decision entry hash is written to NEAR testnet in a real transaction,
// so the audit log is verifiable by anyone with an explorer — no trust in
// this server required.
//
// Default backend: the NEAR Social testnet contract (v1.social08.testnet),
// NEAR's public data contract, via its `set` method. The decision hash and
// verdict are stored under the project's account namespace AND are visible
// verbatim in the transaction's function-call arguments on the explorer.
//
// If AGENTGUARD_CONTRACT_ID is set (a dedicated AgentGuard log contract, see
// contract/), its `log_decision` method is used instead.
//
// If no NEAR credentials are configured, anchoring is OFF and the app says so
// plainly — entries are marked unanchored rather than pretending.

import * as nearAPI from 'near-api-js';
import { readFileSync, existsSync } from 'node:fs';

export const SOCIAL_TESTNET = 'v1.social08.testnet';
export const explorerTxUrl = (txHash) => `https://testnet.nearblocks.io/txns/${txHash}`;

export class NearAnchor {
  constructor({ account = null, dedicatedContractId = null } = {}) {
    this.account = account; // near-api-js Account or null
    this.dedicatedContractId = dedicatedContractId;
  }

  get mode() {
    if (!this.account) return 'off';
    return this.dedicatedContractId ? 'dedicated-contract' : 'near-social';
  }

  async anchorEntry(entry) {
    if (!this.account) return { anchored: false, mode: 'off', note: 'No NEAR credentials configured — entry kept in local hash chain only.' };
    try {
      let outcome;
      if (this.dedicatedContractId) {
        outcome = await this.account.functionCall({
          contractId: this.dedicatedContractId,
          methodName: 'log_decision',
          args: { decision_id: String(entry.seq), entry_hash: entry.hash, verdict: entry.verdict },
          gas: '30000000000000',
        });
      } else {
        const accountId = this.account.accountId;
        const data = {
          [accountId]: {
            agentguard: {
              decisions: {
                [entry.hash]: JSON.stringify({
                  seq: entry.seq,
                  verdict: entry.verdict,
                  risk: entry.riskScore,
                  to: entry.to,
                  amount: entry.amount,
                }),
              },
            },
          },
        };
        // NEAR Social requires a first write from a new account to cover its
        // minimum storage balance; later writes need far less and the unused
        // part of the deposit is refunded. Climb a small ladder on that error.
        let lastErr;
        outcome = null;
        for (const deposit of ['0.02', '0.35']) {
          try {
            outcome = await this.account.functionCall({
              contractId: SOCIAL_TESTNET,
              methodName: 'set',
              args: { data },
              gas: '300000000000000',
              attachedDeposit: nearAPI.utils.format.parseNearAmount(deposit),
            });
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            if (!/storage balance|storage.*deposit/i.test(String(e.message || e))) throw e;
          }
        }
        if (lastErr) throw lastErr;
      }
      const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;
      if (!txHash) throw new Error('No transaction hash in outcome');
      return {
        anchored: true,
        mode: this.mode,
        contractId: this.dedicatedContractId || SOCIAL_TESTNET,
        txHash,
        explorerUrl: explorerTxUrl(txHash),
      };
    } catch (e) {
      return { anchored: false, mode: this.mode, error: String(e.message || e).slice(0, 300) };
    }
  }

  // Read back what is stored on-chain for an entry hash (NEAR Social path).
  async readBack(entryHash) {
    if (!this.account) return null;
    const accountId = this.account.accountId;
    const result = await this.account.viewFunction({
      contractId: SOCIAL_TESTNET,
      methodName: 'get',
      args: { keys: [`${accountId}/agentguard/decisions/${entryHash}`] },
    });
    return result?.[accountId]?.agentguard?.decisions?.[entryHash] ?? null;
  }
}

// Build an anchor from environment + local credential file.
// Env: NEAR_TESTNET_ACCOUNT_ID, NEAR_TESTNET_CREDENTIALS (path to near-cli
// style JSON {account_id, public_key, private_key}), AGENTGUARD_CONTRACT_ID.
export async function anchorFromEnv(env = process.env) {
  const accountId = env.NEAR_TESTNET_ACCOUNT_ID;
  const credPath = env.NEAR_TESTNET_CREDENTIALS;
  if (!accountId || !credPath || !existsSync(credPath)) return new NearAnchor({});
  const creds = JSON.parse(readFileSync(credPath, 'utf8'));
  const keyPair = nearAPI.utils.KeyPair.fromString(creds.private_key);
  const keyStore = new nearAPI.keyStores.InMemoryKeyStore();
  await keyStore.setKey('testnet', accountId, keyPair);
  const near = await nearAPI.connect({
    networkId: 'testnet',
    keyStore,
    nodeUrl: env.NEAR_RPC_URL || 'https://rpc.testnet.near.org',
  });
  const account = await near.account(accountId);
  return new NearAnchor({ account, dedicatedContractId: env.AGENTGUARD_CONTRACT_ID || null });
}
