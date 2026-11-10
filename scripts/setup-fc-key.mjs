// Create the function-call access key the AgentGuard app anchors with.
//
//   node scripts/setup-fc-key.mjs [contractId]
//
// The security model (NEAR AI Security track brief): the service that talks
// to the chain every day should NOT hold a full-access key. This script uses
// the operator's full-access key ONCE to add a function-call access key that:
//   - can call ONLY log_decision on the one log contract,
//   - has a finite NEAR allowance that pays its own gas (default 3 NEAR —
//     thousands of decision logs; when it runs out, anchoring stops and the
//     operator rotates the key; it can never drain the account),
//   - cannot transfer NEAR, add/delete keys, deploy code, or delete the
//     account — those need a full-access key this service never holds.
// The key is written to .near-credentials/testnet/<operator>-fc.json
// (git-ignored). Point NEAR_TESTNET_CREDENTIALS at it in .env.

import * as nearAPI from 'near-api-js';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const operatorId = process.env.NEAR_TESTNET_ACCOUNT_ID;
const fullCredPath = process.env.NEAR_TESTNET_FULL_CREDENTIALS || process.env.NEAR_TESTNET_CREDENTIALS;
const contractId = process.argv[2] || process.env.AGENTGUARD_CONTRACT_ID || `log.${operatorId}`;
if (!operatorId || !fullCredPath) throw new Error('operator env not set');

const creds = JSON.parse(readFileSync(fullCredPath, 'utf8'));
const keyStore = new nearAPI.keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', operatorId, nearAPI.utils.KeyPair.fromString(creds.private_key));
const near = await nearAPI.connect({
  networkId: 'testnet',
  keyStore,
  nodeUrl: process.env.NEAR_RPC_URL || 'https://rpc.testnet.near.org',
});
const operator = await near.account(operatorId);

const keyPair = nearAPI.utils.KeyPairEd25519.fromRandom();
const outcome = await operator.addKey(
  keyPair.publicKey,
  contractId,
  ['log_decision'],
  nearAPI.utils.format.parseNearAmount(process.env.FC_KEY_ALLOWANCE_NEAR || '3'),
);
const outPath = path.join(ROOT, '.near-credentials', 'testnet', `${operatorId}-fc.json`);
writeFileSync(outPath, JSON.stringify({
  account_id: operatorId,
  public_key: keyPair.publicKey.toString(),
  private_key: keyPair.toString(),
}, null, 2));
chmodSync(outPath, 0o600);
console.log(`Function-call key added for ${operatorId} — tx ${outcome?.transaction?.hash}`);
console.log(`  scope: ONLY log_decision on ${contractId}`);
console.log(`  allowance: ${process.env.FC_KEY_ALLOWANCE_NEAR || '3'} NEAR (pays gas; cannot transfer funds)`);
console.log(`  credentials written to ${outPath} (git-ignored)`);
