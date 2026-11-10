// Independent verification of the AgentGuard decision log against NEAR
// testnet. Keyless and read-only — anyone (including judges) can run it:
//
//   node scripts/anchor-check.mjs
//
// It (1) recomputes the local hash chain from data/decisions.jsonl,
// (2) for every anchored entry, reads the value stored on NEAR testnet under
// that entry's hash via the NEAR Social contract's `get`, and checks the
// verdict matches, and (3) confirms each anchor transaction succeeded.

import * as nearAPI from 'near-api-js';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger } from '../src/ledger.js';
import { SOCIAL_TESTNET } from '../src/anchor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT_ID = process.env.NEAR_TESTNET_ACCOUNT_ID || 'agentguard-nh.testnet';
const file = path.join(ROOT, 'data', 'decisions.jsonl');

if (!existsSync(file)) {
  console.error('No data/decisions.jsonl yet — run the app and make some decisions first.');
  process.exit(1);
}

const ledger = new Ledger(file);
const chain = ledger.verifyChain();
console.log(`Hash chain: ${chain.ok ? `VALID (${chain.entries} entries)` : `BROKEN at seq ${chain.atSeq}: ${chain.why}`}`);
if (!chain.ok) process.exit(1);

const provider = new nearAPI.providers.JsonRpcProvider({ url: process.env.NEAR_RPC_URL || 'https://rpc.testnet.near.org' });

let failures = 0;
for (const e of ledger.entries) {
  if (!e.anchor?.anchored) {
    console.log(`#${e.seq} ${e.verdict} — not anchored (local chain only)`);
    continue;
  }
  const key = `${ACCOUNT_ID}/agentguard/decisions/${e.hash}`;
  const res = await provider.query({
    request_type: 'call_function',
    finality: 'final',
    account_id: SOCIAL_TESTNET,
    method_name: 'get',
    args_base64: Buffer.from(JSON.stringify({ keys: [key] })).toString('base64'),
  });
  const stored = JSON.parse(Buffer.from(res.result).toString());
  const value = stored?.[ACCOUNT_ID]?.agentguard?.decisions?.[e.hash];
  const parsed = value ? JSON.parse(value) : null;

  const tx = await provider.txStatus(e.anchor.txHash, ACCOUNT_ID, 'FINAL');
  const txOk = tx?.status && ('SuccessValue' in tx.status || 'SuccessReceiptId' in tx.status);

  const match = parsed && parsed.verdict === e.verdict && parsed.seq === e.seq;
  console.log(`#${e.seq} ${e.verdict} — on-chain verdict: ${parsed?.verdict ?? 'MISSING'} · tx success: ${txOk} · ${match && txOk ? 'MATCH ✓' : 'MISMATCH ✗'}`);
  if (!match || !txOk) failures++;
}

console.log(failures === 0 ? 'ALL ANCHORED ENTRIES VERIFIED ON-CHAIN ✓' : `${failures} verification failure(s)`);
process.exit(failures === 0 ? 0 : 1);
