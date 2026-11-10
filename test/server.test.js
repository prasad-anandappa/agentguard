// Server integration tests: boot the real server against a throwaway data
// dir with anchoring OFF, then drive the HTTP API the way the UI and judges
// do. State is shared across tests in this file on purpose — they read like
// a judge's session, in order.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAuditBundle } from '../src/audit-bundle.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18931 + (process.pid % 400);
const BASE = `http://127.0.0.1:${PORT}`;
let child = null;

const env = { ...process.env, PORT: String(PORT), AGENTGUARD_ANCHOR: 'off' };
delete env.NEAR_TESTNET_ACCOUNT_ID;
delete env.NEAR_TESTNET_CREDENTIALS;
delete env.ALERT_WEBHOOK_URL;
env.AGENTGUARD_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'agentguard-server-'));

async function api(method, p, body, headers = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* badge/svg/html */ }
  return { status: res.status, json, text };
}

const SANDBOX = { 'X-AgentGuard-Sandbox': '1', 'X-AgentGuard-Session': 'judge-test-session' };

before(async () => {
  child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not come up');
});

after(() => { if (child) child.kill('SIGTERM'); });

test('health reports the demo agents and anchoring off', async () => {
  const { json } = await api('GET', '/api/health');
  assert.equal(json.ok, true);
  assert.equal(json.anchorMode, 'off');
  assert.deepEqual(json.agents.sort(), ['agentguard-demo-agent', 'shopping-agent', 'treasury-agent']);
});

test('canonical scenario: legit payment is APPROVED and recorded for the default agent', async () => {
  const { status, json } = await api('POST', '/api/propose', { scenario: 'legit' });
  assert.equal(status, 200);
  assert.equal(json.entry.verdict, 'APPROVED');
  assert.equal(json.entry.agent, 'agentguard-demo-agent');
  assert.ok(Array.isArray(json.entry.trace) && json.entry.trace.length >= 4, 'verdict trace is stored with the entry');
});

test('two-agent scenario: same instruction, opposite verdicts, separate reputations', async () => {
  const { json } = await api('POST', '/api/propose', { scenario: 'twoagents' });
  assert.equal(json.results.length, 2);
  const [shopping, treasury] = json.results;
  assert.equal(shopping.agent, 'shopping-agent');
  assert.equal(shopping.entry.verdict, 'BLOCKED');
  assert.equal(treasury.agent, 'treasury-agent');
  assert.equal(treasury.entry.verdict, 'APPROVED');
  const d = await api('GET', '/api/decisions');
  assert.ok(d.json.reputations['shopping-agent'].blocked >= 1);
  assert.ok(d.json.reputations['treasury-agent'].approved >= 1);
  assert.ok(d.json.stats.attacksStopped >= 1);
});

test('simulation never writes to the ledger', async () => {
  const beforeCount = (await api('GET', '/api/decisions')).json.entries.length;
  const { json } = await api('POST', '/api/simulate', { scenario: 'overlimit' });
  assert.equal(json.simulation, true);
  assert.equal(json.verdict, 'BLOCKED');
  const afterCount = (await api('GET', '/api/decisions')).json.entries.length;
  assert.equal(afterCount, beforeCount);
});

test('policy impact preview counts flips without saving anything', async () => {
  const { json } = await api('POST', '/api/policy/impact', { policy: { perTxLimit: 5 } });
  assert.ok(json.considered >= 1);
  assert.ok(json.flips >= 1);
  const pol = await api('GET', '/api/policy');
  assert.equal(pol.json.perTxLimit, 100, 'impact preview must not mutate the live policy');
});

test('replay: a decision made under the old policy flips under the tightened one', async () => {
  const first = (await api('GET', '/api/decisions')).json.entries.at(-1);
  await api('POST', '/api/policy', { perTxLimit: 5 });
  const { json } = await api('POST', '/api/replay', { seq: first.seq });
  assert.equal(json.then.verdict, 'APPROVED');
  assert.equal(json.now.verdict, 'BLOCKED');
  assert.equal(json.changed, true);
  await api('POST', '/api/policy', { perTxLimit: 100 });
});

test('beneficiary cap blocks through the API and removing it restores flow', async () => {
  await api('POST', '/api/beneficiaries', { account: 'cloud-provider.testnet', note: 'host', capNear: 5 });
  const blocked = await api('POST', '/api/propose', { scenario: 'legit' });
  assert.equal(blocked.json.entry.verdict, 'BLOCKED');
  assert.match(blocked.json.entry.reasons.join(' '), /beneficiary cap/);
  await api('DELETE', '/api/beneficiaries', { account: 'cloud-provider.testnet' });
  const ok = await api('POST', '/api/propose', { scenario: 'legit' });
  assert.equal(ok.json.entry.verdict, 'APPROVED');
});

test('standing instruction: register, run an occurrence, count it', async () => {
  const created = await api('POST', '/api/standing', { to: 'api-market.testnet', amount: 10, memo: 'API data credits', cadence: 'weekly' });
  assert.equal(created.status, 201);
  const id = created.json.standing.id;
  const run = await api('POST', `/api/standing/${id}/run`, {});
  assert.equal(run.json.occurrence, 1);
  assert.equal(run.json.entry.verdict, 'APPROVED');
  const list = await api('GET', '/api/standing');
  assert.equal(list.json.standing[0].occurrencesRun, 1);
});

test('review inbox flow: first payment is HELD with an alert, then resolved by a human', async () => {
  const held = await api('POST', '/api/propose', { scenario: 'firstpay' });
  assert.equal(held.json.entry.verdict, 'REVIEW');
  assert.equal(held.json.alert.payload.alert, 'REVIEW');
  assert.equal(held.json.alert.delivery.mode, 'display-only');
  const d = await api('GET', '/api/decisions');
  assert.equal(d.json.pendingReview.length, 1);
  const resolved = await api('POST', '/api/review', { seq: held.json.entry.seq, decision: 'approve' });
  assert.equal(resolved.json.entry.verdict, 'APPROVED');
  assert.equal(resolved.json.entry.kind, 'resolution');
  const d2 = await api('GET', '/api/decisions');
  assert.equal(d2.json.pendingReview.length, 0);
});

test('audit bundle verifies offline and imports into a sandbox — never into the live canonical log', async () => {
  const bundleRes = await api('GET', '/api/audit-bundle');
  const bundle = bundleRes.json;
  assert.equal(verifyAuditBundle(bundle).ok, true);
  const refused = await api('POST', '/api/ledger/import', { bundle });
  assert.equal(refused.status, 409);
  const tampered = JSON.parse(JSON.stringify(bundle));
  tampered.entries[0].amount = 424242;
  const badImport = await api('POST', '/api/ledger/import', { bundle: tampered }, SANDBOX);
  assert.equal(badImport.status, 400);
  const good = await api('POST', '/api/ledger/import', { bundle }, SANDBOX);
  assert.equal(good.status, 200);
  assert.equal(good.json.imported, bundle.entries.length);
});

test('judge sandbox is isolated from the canonical ledger', async () => {
  const canonBefore = (await api('GET', '/api/decisions')).json.entries.length;
  const sb = await api('POST', '/api/propose', { scenario: 'overlimit' }, { 'X-AgentGuard-Sandbox': '1', 'X-AgentGuard-Session': 'judge-test-session-2' });
  assert.equal(sb.json.entry.verdict, 'BLOCKED');
  assert.equal(sb.json.entry.anchor.anchored, false);
  const canonAfter = (await api('GET', '/api/decisions')).json.entries.length;
  assert.equal(canonAfter, canonBefore);
  const sbHealth = await api('GET', '/api/health', undefined, { 'X-AgentGuard-Sandbox': '1', 'X-AgentGuard-Session': 'judge-test-session-2' });
  assert.equal(sbHealth.json.sandbox, true);
  assert.equal(sbHealth.json.decisions, 1);
});

test('badge endpoint renders an SVG for a real decision and a 404 badge otherwise', async () => {
  const entries = (await api('GET', '/api/decisions')).json.entries;
  const target = entries.find((e) => e.verdict === 'APPROVED');
  const ok = await api('GET', `/badge/${target.hash}.svg`);
  assert.equal(ok.status, 200);
  assert.match(ok.text, /APPROVED/);
  const missing = await api('GET', `/badge/${'e'.repeat(64)}.svg`);
  assert.equal(missing.status, 404);
  assert.match(missing.text, /not found/);
});

test('status API and pages: /api/status shape, /verify and /status pages serve', async () => {
  const { json } = await api('GET', '/api/status');
  assert.equal(json.service, 'agentguard');
  assert.equal(typeof json.uptimeSeconds, 'number');
  assert.ok('contractChainHeight' in json);
  assert.equal(json.lastAnchored, null, 'anchoring is off in tests, so nothing is anchored');
  const verify = await api('GET', '/verify');
  assert.equal(verify.status, 200);
  assert.match(verify.text, /AgentGuard/);
  const status = await api('GET', '/status');
  assert.equal(status.status, 200);
});

test('attacks catalogue lists the five one-tap attacks', async () => {
  const { json } = await api('GET', '/api/attacks');
  assert.equal(json.length, 5);
  assert.ok(json.some((c) => c.id === 'installments' && c.times === 3));
});
