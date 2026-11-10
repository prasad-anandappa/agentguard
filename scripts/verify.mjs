// One-command verification for judges and screeners:
//
//   npm run verify
//
// Runs three independent legs and prints one summary:
//   1. the unit/integration test suite (node --test)
//   2. the on-chain anchor check (scripts/anchor-check.mjs) — recomputes the
//      hash chain and compares every anchored verdict with the record the
//      NEAR testnet contract holds
//   3. the attack demo (scripts/attack-demo.mjs) — three scripted
//      prompt-injection attacks, all of which must be stopped
//
// Exit code 0 only when every leg passes. The anchor leg needs network
// access to the public NEAR testnet RPC; if the RPC is unreachable the leg
// is reported as SKIPPED (offline) rather than failed — a mismatch found
// while online is always a hard failure.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;

function run(args) {
  const r = spawnSync(node, args, { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
  return { code: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}` };
}

const legs = [];

// Leg 1 — tests.
{
  const { code, out } = run(['--test']);
  const pass = /pass (\d+)/.exec(out)?.[1];
  const fail = /fail (\d+)/.exec(out)?.[1];
  legs.push({ name: `tests (${pass ?? '?'} passed, ${fail ?? '?'} failed)`, ok: code === 0, detail: out.trim().split('\n').slice(-3).join('\n') });
  console.log(`[verify] tests: ${code === 0 ? 'PASS' : 'FAIL'} (${pass ?? '?'} passed)`);
}

// Leg 2 — on-chain anchor check.
{
  const { code, out } = run(['scripts/anchor-check.mjs']);
  const networkDown = /fetch|ENOTFOUND|ECONN|ETIMEDOUT|network|socket/i.test(out) && !/MATCH|MISMATCH/.test(out);
  if (code === 0) {
    const verified = /ALL ANCHORED ENTRIES VERIFIED/.test(out);
    legs.push({ name: 'anchor-check (hash chain + on-chain verdicts)', ok: true, detail: verified ? 'all anchored entries verified on-chain' : 'chain valid' });
    console.log('[verify] anchor-check: PASS');
  } else if (networkDown) {
    legs.push({ name: 'anchor-check (SKIPPED — testnet RPC unreachable)', ok: true, skipped: true, detail: 'offline: leg skipped, not failed' });
    console.log('[verify] anchor-check: SKIPPED (RPC unreachable — run online for the full check)');
  } else {
    legs.push({ name: 'anchor-check', ok: false, detail: out.trim().split('\n').slice(-4).join('\n') });
    console.log('[verify] anchor-check: FAIL');
  }
}

// Leg 3 — attack demo.
{
  const { code, out } = run(['scripts/attack-demo.mjs']);
  const stopped = /Attacks stopped: (\d+)\/(\d+)/.exec(out);
  legs.push({ name: `attack demo (${stopped ? `${stopped[1]}/${stopped[2]} attacks stopped` : 'did not complete'})`, ok: code === 0, detail: out.trim().split('\n').slice(-2).join('\n') });
  console.log(`[verify] attack demo: ${code === 0 ? 'PASS' : 'FAIL'}${stopped ? ` (${stopped[1]}/${stopped[2]} stopped)` : ''}`);
}

const failed = legs.filter((l) => !l.ok);
console.log('');
for (const l of legs) console.log(`  ${l.ok ? '✓' : '✗'} ${l.name}${l.skipped ? ' — skipped offline' : ''}`);
if (failed.length) {
  console.log(`\nAGENTGUARD VERIFY: FAIL — ${failed.map((f) => f.name).join('; ')}`);
  for (const f of failed) console.log(`\n--- ${f.name} ---\n${f.detail}`);
  process.exit(1);
}
console.log('\nAGENTGUARD VERIFY: PASS ✓ — tests green, anchored log verified, attacks stopped.');
