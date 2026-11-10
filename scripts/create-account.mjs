// Creates the project's throwaway NEAR *testnet* dev account used only to
// anchor demo decision hashes. This is NOT Prasad's wallet and NOT the prize
// payout account (that mainnet account is a human-only step — see PLAN.md).
// The secret key is written only to .near-credentials/ (gitignored) and ./.env
// (gitignored). It is never printed.
import * as nearAPI from 'near-api-js';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const { connect, keyStores, utils, accountCreator } = nearAPI;

const CANDIDATES = process.argv[2]
  ? [process.argv[2]]
  : [
      'agentguard-nh.testnet',
      'agentguard-nh-2026.testnet',
      'agentguard-hack.testnet',
      'agentguard-demo-nh.testnet',
    ];

const credDir = path.resolve('.near-credentials/testnet');
if (CANDIDATES.some((id) => existsSync(path.join(credDir, `${id}.json`)))) {
  console.log('Credentials already exist locally; skipping creation.');
  process.exit(0);
}

const keyPair = utils.KeyPair.fromRandom('ed25519');
const publicKey = keyPair.getPublicKey().toString();

const keyStore = new keyStores.InMemoryKeyStore();
const config = {
  networkId: 'testnet',
  keyStore,
  nodeUrl: 'https://rpc.testnet.near.org',
  walletUrl: 'https://testnet.mynearwallet.com',
  helperUrl: 'https://helper.testnet.near.org',
};
const near = await connect(config);
const creator = new accountCreator.UrlAccountCreator(
  near.connection,
  config.helperUrl,
);

let created = null;
for (const accountId of CANDIDATES) {
  try {
    // Check availability first via RPC (account should NOT exist).
    try {
      await near.connection.provider.query({
        request_type: 'view_account',
        finality: 'final',
        account_id: accountId,
      });
      console.log(`${accountId}: already exists, trying next`);
      continue;
    } catch (_) {
      /* not existing is what we want */
    }
    await creator.createAccount(accountId, keyPair.getPublicKey());
    created = accountId;
    break;
  } catch (e) {
    console.log(`${accountId}: creation failed (${e.type || e.message || e})`);
  }
}

if (!created) {
  console.error('FAILED: could not create any candidate testnet account.');
  process.exit(1);
}

mkdirSync(credDir, { recursive: true });
const credFile = path.join(credDir, `${created}.json`);
writeFileSync(
  credFile,
  JSON.stringify(
    {
      account_id: created,
      public_key: publicKey,
      private_key: keyPair.toString(),
    },
    null,
    2,
  ),
  { mode: 0o600 },
);

const account = await near.account(created);
const state = await account.state();
console.log(`CREATED testnet account: ${created}`);
console.log(`Public key: ${publicKey}`);
console.log(`Balance: ${utils.format.formatNearAmount(state.amount)} NEAR`);
console.log(`Credentials saved to ${credFile} (mode 600, gitignored).`);
