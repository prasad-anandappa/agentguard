// AgentGuard server — zero-framework Node http server.
// Serves the demo UI and the JSON API the UI (and judges) can drive directly.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nearAPI from 'near-api-js';
import { DEFAULT_POLICY, evaluateProposal } from './policy.js';
import { Ledger } from './ledger.js';
import { anchorFromEnv } from './anchor.js';
import { proposePayment, DEMO_SCENARIOS } from './agent.js';
import { checkCounterparty, withTimeout } from './counterparty.js';
import { BlocklistStore } from './blocklist.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..');

// Tiny .env loader (no dependency): KEY=VALUE lines from ./.env if present.
const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const PORT = Number(process.env.PORT || 8787);
const ledger = new Ledger(path.join(ROOT, 'data', 'decisions.jsonl'));
const blocklist = new BlocklistStore(path.join(ROOT, 'data', 'blocklist.json'));
const anchor = await anchorFromEnv();
let policy = { ...DEFAULT_POLICY };

// Keyless read-only RPC provider for counterparty screening (never signs).
const rpcProvider = new nearAPI.providers.JsonRpcProvider({
  url: process.env.NEAR_RPC_URL || 'https://rpc.testnet.near.org',
});

const AGENT_ID = 'agentguard-demo-agent';

// The human's saved policy plus every community-reported scam destination.
function effectivePolicy() {
  const merged = new Set([...policy.blockedDestinations, ...blocklist.destinations()]);
  return { ...policy, blockedDestinations: [...merged] };
}

async function guardAndRecord(instruction) {
  const { proposal, via } = await proposePayment(instruction);
  const priorInteractions = ledger.entries.filter((e) => e.to === proposal.to.toLowerCase()).length;
  const counterparty = (await withTimeout(
    checkCounterparty(proposal.to.toLowerCase(), { provider: rpcProvider, priorInteractions }),
    4000,
  )) || { account: proposal.to, status: 'unavailable', findings: [] };
  const context = {
    spentToday: ledger.spentToday(),
    seenDestinations: ledger.seenDestinations(),
    extraFindings: counterparty.findings || [],
  };
  const result = evaluateProposal(proposal, effectivePolicy(), context);
  const entry = ledger.append({ agent: AGENT_ID, proposal, verdict: result.verdict, riskScore: result.riskScore, reasons: result.reasons });
  const { findings: _f, ...counterpartyPublic } = counterparty;
  ledger.setCounterparty(entry.seq, counterpartyPublic);
  entry.anchor = await anchor.anchorEntry(entry);
  ledger.setAnchor(entry.seq, entry.anchor);
  return { entry, via, policy: { perTxLimit: policy.perTxLimit, dailyLimit: policy.dailyLimit } };
}

// A human decides a held (REVIEW) decision. The decision is appended as a
// resolution entry — the ledger stays append-only — and anchored like any
// other decision.
async function resolveReview(seq, decision, note) {
  const original = ledger.entries.find((e) => e.seq === seq);
  if (!original) return { error: 'no such decision', code: 404 };
  if (original.verdict !== 'REVIEW') return { error: `decision #${seq} is ${original.verdict}, not held for review`, code: 409 };
  if (!ledger.pendingReview().some((e) => e.seq === seq)) return { error: `decision #${seq} was already resolved`, code: 409 };
  const verdict = decision === 'approve' ? 'APPROVED' : 'BLOCKED';
  const reasons = [`Human ${decision === 'approve' ? 'approved' : 'denied'} held decision #${seq}${note ? ` — ${String(note).slice(0, 200)}` : ''}`];
  const entry = ledger.append({
    agent: original.agent,
    proposal: { to: original.to, amount: original.amount, memo: original.memo },
    verdict,
    riskScore: original.riskScore,
    reasons,
    kind: 'resolution',
    refSeq: seq,
  });
  entry.anchor = await anchor.anchorEntry(entry);
  ledger.setAnchor(entry.seq, entry.anchor);
  return { entry };
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) reject(new Error('body too large')); });
    req.on('end', () => resolve(data ? JSON.parse(data) : {}));
    req.on('error', reject);
  });
}

const accountList = (v, max = 100) => (Array.isArray(v)
  ? v.map((x) => String(x).toLowerCase().trim()).filter((x) => /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(x) && x.length <= 64).slice(0, max)
  : undefined);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (req.method === 'GET' && url.pathname === '/') {
      const html = readFileSync(path.join(ROOT, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'agentguard',
        network: 'near-testnet',
        anchorMode: anchor.mode,
        anchorAccount: anchor.account?.accountId || null,
        anchorContract: anchor.dedicatedContractId || null,
        decisions: ledger.entries.length,
        pendingReview: ledger.pendingReview().length,
        chainValid: ledger.verifyChain().ok,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/scenarios') {
      return sendJson(res, 200, DEMO_SCENARIOS);
    }
    if (req.method === 'GET' && url.pathname === '/api/policy') {
      return sendJson(res, 200, effectivePolicy());
    }
    if (req.method === 'POST' && url.pathname === '/api/policy') {
      const body = await readBody(req);
      const num = (v, min, max) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : undefined);
      policy = {
        ...policy,
        perTxLimit: num(body.perTxLimit, 0.01, 1e6) ?? policy.perTxLimit,
        dailyLimit: num(body.dailyLimit, 0.01, 1e6) ?? policy.dailyLimit,
        requireAllowlist: typeof body.requireAllowlist === 'boolean' ? body.requireAllowlist : policy.requireAllowlist,
        allowedDestinations: accountList(body.allowedDestinations) ?? policy.allowedDestinations,
        blockedDestinations: accountList(body.blockedDestinations) ?? policy.blockedDestinations,
        knownPayees: accountList(body.knownPayees) ?? policy.knownPayees,
      };
      return sendJson(res, 200, effectivePolicy());
    }
    if (req.method === 'POST' && url.pathname === '/api/propose') {
      const body = await readBody(req);
      const instruction = body.scenario && DEMO_SCENARIOS[body.scenario]
        ? DEMO_SCENARIOS[body.scenario].instruction
        : String(body.instruction || '');
      if (!instruction) return sendJson(res, 400, { error: 'instruction or scenario required' });
      const out = await guardAndRecord(instruction);
      return sendJson(res, 200, out);
    }
    if (req.method === 'POST' && url.pathname === '/api/review') {
      const body = await readBody(req);
      const seq = Number(body.seq);
      if (!Number.isInteger(seq) || !['approve', 'deny'].includes(body.decision)) {
        return sendJson(res, 400, { error: 'body must be {seq: <held decision number>, decision: "approve"|"deny", note?}' });
      }
      const out = await resolveReview(seq, body.decision, body.note);
      if (out.error) return sendJson(res, out.code, { error: out.error });
      return sendJson(res, 200, out);
    }
    if (req.method === 'GET' && url.pathname === '/api/blocklist') {
      return sendJson(res, 200, { builtIn: policy.blockedDestinations, reported: blocklist.reports });
    }
    if (req.method === 'POST' && url.pathname === '/api/blocklist') {
      const body = await readBody(req);
      try {
        const { report, added } = blocklist.add(body.destination, body.evidence);
        return sendJson(res, added ? 201 : 200, { report, added, effectiveBlocked: effectivePolicy().blockedDestinations });
      } catch (e) {
        return sendJson(res, 400, { error: String(e.message || e) });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/report') {
      return sendJson(res, 200, {
        generatedAt: new Date().toISOString(),
        service: 'agentguard',
        network: 'near-testnet',
        anchor: { mode: anchor.mode, account: anchor.account?.accountId || null, contract: anchor.dedicatedContractId || null },
        policy: effectivePolicy(),
        chain: ledger.verifyChain(),
        reputation: ledger.reputation(AGENT_ID),
        pendingReview: ledger.pendingReview(),
        blocklist: { builtIn: policy.blockedDestinations, reported: blocklist.reports },
        entries: ledger.entries,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/decisions') {
      return sendJson(res, 200, {
        chain: ledger.verifyChain(),
        reputation: ledger.reputation(AGENT_ID),
        spentToday: ledger.spentToday(),
        pendingReview: ledger.pendingReview(),
        entries: [...ledger.entries].reverse(),
      });
    }
    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    return sendJson(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`AgentGuard running at http://localhost:${PORT} (anchor mode: ${anchor.mode})`);
});
