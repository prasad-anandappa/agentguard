// Independent verification of the AgentGuard decision log against NEAR
// testnet. Keyless and read-only — anyone (including judges) can run it:
//
//   node scripts/anchor-check.mjs
//
// It (1) recomputes the local hash chain from data/decisions.jsonl,
// (2) for every anchored entry, reads the verdict recorded on NEAR testnet
// for that entry's hash — via the NEAR Social contract's `get` for
// near-social anchors, or via the dedicated AgentGuard log contract's
// `get_decision` for contract anchors — and checks the verdict matches, and
// (3) confirms each anchor transaction succeeded.

import * as nearAPI from 'near-api-js';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger } from '../src/ledger.js';
import { SOCIAL_TESTNET } from '../src/anchor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT_ID = process.env.NEAR_TESTNET_ACCOUNT_ID || 'agentguard-nh.testnet';
const CONTRACT_ID = process.env.AGENTGUARD_CONTRACT_ID || 'log.agentguard-nh.testnet';
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

async function callView(contractId, methodName, args) {
  const res = await provider.query({
    request_type: 'call_function',
    finality: 'final',
    account_id: contractId,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  return JSON.parse(Buffer.from(res.result).toString());
}

let failures = 0;
for (const e of ledger.entries) {
  if (!e.anchor?.anchored) {
    console.log(`#${e.seq} ${e.verdict} — not anchored (local chain only)`);
    continue;
  }
  let onChainVerdict = null;
  if (e.anchor.mode === 'dedicated-contract') {
    const raw = await callView(e.anchor.contractId || CONTRACT_ID, 'get_decision', { entry_hash: e.hash });
    const parsed = raw ? JSON.parse(raw) : null;
    onChainVerdict = parsed?.verdict ?? null;
    var match = Boolean(parsed && parsed.verdict === e.verdict && parsed.decision_id === String(e.seq));
  } else {
    const key = `${ACCOUNT_ID}/agentguard/decisions/${e.hash}`;
    const stored = await callView(SOCIAL_TESTNET, 'get', { keys: [key] });
    const value = stored?.[ACCOUNT_ID]?.agentguard?.decisions?.[e.hash];
    const parsed = value ? JSON.parse(value) : null;
    onChainVerdict = parsed?.verdict ?? null;
    var match = Boolean(parsed && parsed.verdict === e.verdict && parsed.seq === e.seq);
  }

  const tx = await provider.txStatus(e.anchor.txHash, ACCOUNT_ID, 'FINAL');
  const txOk = tx?.status && ('SuccessValue' in tx.status || 'SuccessReceiptId' in tx.status);

  console.log(`#${e.seq} ${e.verdict} — on-chain verdict (${e.anchor.mode}): ${onChainVerdict ?? 'MISSING'} · tx success: ${txOk} · ${match && txOk ? 'MATCH ✓' : 'MISMATCH ✗'}`);
  if (!match || !txOk) failures++;
}

console.log(failures === 0 ? 'ALL ANCHORED ENTRIES VERIFIED ON-CHAIN ✓' : `${failures} verification failure(s)`);
process.exit(failures === 0 ? 0 : 1);
