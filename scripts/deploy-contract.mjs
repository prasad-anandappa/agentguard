// Deploy the AgentGuard log contract to NEAR testnet and initialise it.
//
//   node scripts/deploy-contract.mjs [path-to-wasm]
//
// - Contract account: AGENTGUARD_CONTRACT_ACCOUNT or log.<operator>.testnet
//   (created with 2 test NEAR from the operator if it doesn't exist yet).
// - Operator credentials: NEAR_TESTNET_ACCOUNT_ID + NEAR_TESTNET_CREDENTIALS
//   (the operator's full-access key file; used ONLY by this setup script —
//   the running app never sees it, see setup-fc-key.mjs).
// - Init: new(owner_id = operator), so only the operator can log decisions.
//
// Idempotent: safe to re-run; an already-initialised contract is reported,
// not re-initialised.

import * as nearAPI from 'near-api-js';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = process.argv[2] || path.join(ROOT, 'contract', 'agentguard_log.wasm');

const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const operatorId = process.env.NEAR_TESTNET_ACCOUNT_ID;
const credPath = process.env.NEAR_TESTNET_CREDENTIALS;
if (!operatorId || !credPath) throw new Error('NEAR_TESTNET_ACCOUNT_ID / NEAR_TESTNET_CREDENTIALS not set');
if (!existsSync(wasmPath)) throw new Error(`wasm not found at ${wasmPath} — build it first (CI artifact or cargo build)`);

const contractId = process.env.AGENTGUARD_CONTRACT_ACCOUNT || `log.${operatorId}`;
const creds = JSON.parse(readFileSync(credPath, 'utf8'));
const keyStore = new nearAPI.keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', operatorId, nearAPI.utils.KeyPair.fromString(creds.private_key));
const near = await nearAPI.connect({
  networkId: 'testnet',
  keyStore,
  nodeUrl: process.env.NEAR_RPC_URL || 'https://rpc.testnet.near.org',
});
const provider = near.connection.provider;
const operator = await near.account(operatorId);

// 1. Create the contract subaccount if needed, keeping its key locally.
const contractCredPath = path.join(ROOT, '.near-credentials', 'testnet', `${contractId}.json`);
let contractExists = true;
try {
  await provider.query({ request_type: 'view_account', finality: 'final', account_id: contractId });
} catch {
  contractExists = false;
}
if (!contractExists) {
  const keyPair = nearAPI.utils.KeyPairEd25519.fromRandom();
  await operator.createAccount(contractId, keyPair.publicKey, nearAPI.utils.format.parseNearAmount('2'));
  writeFileSync(contractCredPath, JSON.stringify({
    account_id: contractId,
    public_key: keyPair.publicKey.toString(),
    private_key: keyPair.toString(),
  }, null, 2));
  chmodSync(contractCredPath, 0o600);
  await keyStore.setKey('testnet', contractId, keyPair);
  console.log(`Created contract account ${contractId} (funded 2 test NEAR)`);
} else {
  console.log(`Contract account ${contractId} already exists`);
  if (existsSync(contractCredPath)) {
    const cc = JSON.parse(readFileSync(contractCredPath, 'utf8'));
    await keyStore.setKey('testnet', contractId, nearAPI.utils.KeyPair.fromString(cc.private_key));
  }
}

// 2. Deploy the wasm from the contract account itself.
const contractAccount = await near.account(contractId);
const wasm = readFileSync(wasmPath);
const deployOutcome = await contractAccount.deployContract(wasm);
console.log(`Deployed ${wasm.length} bytes to ${contractId} — tx ${deployOutcome?.transaction?.hash}`);

// 3. Initialise with the operator as owner (tolerate "already initialised").
try {
  const initOutcome = await contractAccount.functionCall({
    contractId,
    methodName: 'new',
    args: { owner_id: operatorId },
    gas: '30000000000000',
  });
  console.log(`Initialised, owner = ${operatorId} — tx ${initOutcome?.transaction?.hash}`);
} catch (e) {
  if (/already been initialized|The contract has already been initialized/i.test(String(e.message || e))) {
    console.log('Contract was already initialised — leaving state untouched');
  } else throw e;
}

// 4. Read back.
const total = await contractAccount.viewFunction({ contractId, methodName: 'total_decisions', args: {} });
console.log(`total_decisions() = ${total}`);
console.log(`\nContract live: ${contractId}`);
console.log(`Set AGENTGUARD_CONTRACT_ID=${contractId} to anchor through it.`);
