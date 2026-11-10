// AgentGuard server — zero-framework Node http server.
// Serves the demo UI and the JSON API the UI (and judges) can drive directly.
//
// Two kinds of runtime share this code:
//  - the CANONICAL runtime: file-backed ledger in AGENTGUARD_DATA_DIR
//    (default ./data), anchored to NEAR testnet when credentials exist.
//  - JUDGE SANDBOX runtimes: in-memory, per-session, anchoring OFF, created
//    when a request carries X-AgentGuard-Sandbox: 1 + X-AgentGuard-Session.
//    Sandboxes let judges experiment freely; they can never write to the
//    canonical proof log.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nearAPI from 'near-api-js';
import { DEFAULT_POLICY, evaluateProposal } from './policy.js';
import { Ledger } from './ledger.js';
import { anchorFromEnv, NearAnchor } from './anchor.js';
import { proposePayment, DEMO_SCENARIOS, DEMO_AGENTS, ATTACK_CHIPS } from './agent.js';
import { checkCounterparty, withTimeout } from './counterparty.js';
import { BlocklistStore } from './blocklist.js';
import { BeneficiaryStore } from './beneficiaries.js';
import { buildAlertPayload, deliverAlert } from './alerts.js';
import { buildAuditBundle, verifyAuditBundle } from './audit-bundle.js';
import { replayProposal, summarizeFlips } from './replay.js';
import { createStandingInstruction } from './standing.js';
import { priceOracle } from './price.js';
import { badgeSvg } from './badge.js';

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
const STARTED_AT = new Date().toISOString();
const DEFAULT_AGENT = 'agentguard-demo-agent';

// Keyless read-only RPC provider for counterparty screening (never signs).
const rpcProvider = new nearAPI.providers.JsonRpcProvider({
  url: process.env.NEAR_RPC_URL || 'https://rpc.testnet.near.org',
});

const anchorEnabled = process.env.AGENTGUARD_ANCHOR !== 'off';
const canonicalAnchor = anchorEnabled ? await anchorFromEnv() : new NearAnchor({});

function freshAgentPolicies() {
  const map = new Map();
  for (const a of DEMO_AGENTS) {
    map.set(a.id, { ...DEFAULT_POLICY, ...(a.policy || {}) });
  }
  return map;
}

function makeRuntime({ dataDir = null, anchor }) {
  return {
    sandbox: !dataDir,
    ledger: new Ledger(dataDir ? path.join(dataDir, 'decisions.jsonl') : null),
    blocklist: new BlocklistStore(dataDir ? path.join(dataDir, 'blocklist.json') : null),
    beneficiaries: new BeneficiaryStore(dataDir ? path.join(dataDir, 'beneficiaries.json') : null),
    agentPolicies: freshAgentPolicies(),
    standing: [],
    anchor,
  };
}

const canonical = makeRuntime({
  dataDir: process.env.AGENTGUARD_DATA_DIR || path.join(ROOT, 'data'),
  anchor: canonicalAnchor,
});
const sandboxes = new Map(); // sessionId -> runtime

function resolveRuntime(req) {
  if (req.headers['x-agentguard-sandbox'] === '1') {
    const sid = String(req.headers['x-agentguard-session'] || '').slice(0, 80);
    if (sid) {
      if (!sandboxes.has(sid)) sandboxes.set(sid, makeRuntime({ anchor: new NearAnchor({}) }));
      return sandboxes.get(sid);
    }
  }
  return canonical;
}

const agentLabel = (id) => DEMO_AGENTS.find((a) => a.id === id)?.label || id;

// The human's saved policy for one agent plus every community-reported
// scam destination.
function effectivePolicy(rt, agentId) {
  const base = rt.agentPolicies.get(agentId) || rt.agentPolicies.get(DEFAULT_AGENT);
  const merged = new Set([...base.blockedDestinations, ...rt.blocklist.destinations()]);
  return { ...base, blockedDestinations: [...merged] };
}

function knownAgent(rt, agentId) {
  return rt.agentPolicies.has(agentId) ? agentId : DEFAULT_AGENT;
}

// Build the full evaluation context for one agent from the runtime ledger.
async function buildContext(rt, agentId, proposal) {
  const policy = effectivePolicy(rt, agentId);
  const priorInteractions = rt.ledger.entries.filter((e) => e.to === proposal.to.toLowerCase()).length;
  const counterparty = (await withTimeout(
    checkCounterparty(proposal.to.toLowerCase(), { provider: rpcProvider, priorInteractions }),
    4000,
  )) || { account: proposal.to, status: 'unavailable', findings: [] };
  const trust = rt.ledger.counterpartyTrust(policy.graduationThreshold ?? 3);
  const context = {
    spentToday: rt.ledger.spentToday(new Date(), agentId),
    seenDestinations: rt.ledger.seenDestinations(agentId),
    trustedDestinations: new Set(Object.values(trust).filter((t) => t.trusted).map((t) => t.destination)),
    recentPayments: rt.ledger.recentPayments(agentId),
    spentThisMonthByCategory: rt.ledger.categorySpendThisMonth(agentId),
    beneficiaryCap: rt.beneficiaries.capFor(proposal.to),
    extraFindings: counterparty.findings || [],
  };
  return { policy, context, counterparty };
}

async function maybeAlert(rt, entry) {
  if (entry.verdict !== 'BLOCKED' && entry.verdict !== 'REVIEW') return null;
  const payload = buildAlertPayload(entry, { contractId: rt.anchor.dedicatedContractId || null });
  const delivery = await deliverAlert(payload, rt.sandbox ? { displayOnlyReason: 'Sandbox runtime — alerts are display-only.' } : {});
  return { payload, delivery };
}

async function guardAndRecord(rt, instruction, agentId = DEFAULT_AGENT) {
  const agent = knownAgent(rt, agentId);
  const { proposal, via } = await proposePayment(instruction);
  const { policy, context, counterparty } = await buildContext(rt, agent, proposal);
  const result = evaluateProposal(proposal, policy, context);
  const entry = rt.ledger.append({ agent, proposal, verdict: result.verdict, riskScore: result.riskScore, reasons: result.reasons });
  const { findings: _f, ...counterpartyPublic } = counterparty;
  rt.ledger.setCounterparty(entry.seq, counterpartyPublic);
  rt.ledger.setTrace(entry.seq, result.trace);
  entry.anchor = await rt.anchor.anchorEntry(entry);
  rt.ledger.setAnchor(entry.seq, entry.anchor);
  const alert = await maybeAlert(rt, entry);
  return {
    entry, via, agent,
    policy: { perTxLimit: policy.perTxLimit, dailyLimit: policy.dailyLimit },
    reputation: rt.ledger.reputation(agent),
    alert,
  };
}

// A human decides a held (REVIEW) decision. The decision is appended as a
// resolution entry — the ledger stays append-only — and anchored like any
// other decision.
async function resolveReview(rt, seq, decision, note) {
  const original = rt.ledger.entries.find((e) => e.seq === seq);
  if (!original) return { error: 'no such decision', code: 404 };
  if (original.verdict !== 'REVIEW') return { error: `decision #${seq} is ${original.verdict}, not held for review`, code: 409 };
  if (!rt.ledger.pendingReview().some((e) => e.seq === seq)) return { error: `decision #${seq} was already resolved`, code: 409 };
  const verdict = decision === 'approve' ? 'APPROVED' : 'BLOCKED';
  const reasons = [`Human ${decision === 'approve' ? 'approved' : 'denied'} held decision #${seq}${note ? ` — ${String(note).slice(0, 200)}` : ''}`];
  const entry = rt.ledger.append({
    agent: original.agent,
    proposal: { to: original.to, amount: original.amount, memo: original.memo },
    verdict,
    riskScore: original.riskScore,
    reasons,
    kind: 'resolution',
    refSeq: seq,
  });
  entry.anchor = await rt.anchor.anchorEntry(entry);
  rt.ledger.setAnchor(entry.seq, entry.anchor);
  const alert = await maybeAlert(rt, entry);
  return { entry, alert };
}

// Dry-run: full parse + evaluation, NO ledger write, NO anchoring.
async function simulate(rt, instruction, agentId, policyOverride) {
  const agent = knownAgent(rt, agentId);
  const { proposal, via } = await proposePayment(instruction);
  const { policy: current, context } = await buildContext(rt, agent, proposal);
  const policy = policyOverride ? { ...current, ...policyOverride } : current;
  const result = evaluateProposal(proposal, policy, context);
  return {
    simulation: true,
    agent,
    via,
    proposal,
    verdict: result.verdict,
    riskScore: result.riskScore,
    reasons: result.reasons,
    trace: result.trace,
    policy: { perTxLimit: policy.perTxLimit, dailyLimit: policy.dailyLimit },
  };
}

// Contract decision count (chain height), keyless, cached — for /api/status.
let heightCache = { value: null, at: 0 };
async function contractHeight(contractId) {
  if (!contractId) return null;
  if (Date.now() - heightCache.at < 30_000 && heightCache.contract === contractId) return heightCache.value;
  try {
    const res = await rpcProvider.query({
      request_type: 'call_function', finality: 'final', account_id: contractId,
      method_name: 'total_decisions', args_base64: Buffer.from('{}').toString('base64'),
    });
    const value = Number(JSON.parse(Buffer.from(res.result).toString()));
    heightCache = { value: Number.isFinite(value) ? value : null, at: Date.now(), contract: contractId };
  } catch (_) {
    heightCache = { value: null, at: Date.now(), contract: contractId };
  }
  return heightCache.value;
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

const numField = (v, min, max) => (Number.isFinite(Number(v)) && v !== null && v !== undefined && v !== '' ? Math.min(max, Math.max(min, Number(v))) : undefined);

function coercePolicyPatch(body, base) {
  const patch = {
    perTxLimit: numField(body.perTxLimit, 0.01, 1e6),
    dailyLimit: numField(body.dailyLimit, 0.01, 1e6),
    firstTimeReviewThreshold: numField(body.firstTimeReviewThreshold, 0, 1e6),
    firstTimeBlockThreshold: numField(body.firstTimeBlockThreshold, 0, 1e6),
    graduationThreshold: numField(body.graduationThreshold, 1, 100),
    velocityWindowMinutes: numField(body.velocityWindowMinutes, 1, 1440),
    velocityMaxCount: numField(body.velocityMaxCount, 1, 1000),
    velocityMaxOutflow: numField(body.velocityMaxOutflow, 0.01, 1e9),
    requireAllowlist: typeof body.requireAllowlist === 'boolean' ? body.requireAllowlist : undefined,
    velocityAction: ['REVIEW', 'BLOCK'].includes(body.velocityAction) ? body.velocityAction : undefined,
    allowedDestinations: accountList(body.allowedDestinations),
    blockedDestinations: accountList(body.blockedDestinations),
    knownPayees: accountList(body.knownPayees),
  };
  if (body.categoryBudgets && typeof body.categoryBudgets === 'object') {
    patch.categoryBudgets = { ...base.categoryBudgets };
    for (const cat of ['hosting', 'dev', 'tools', 'other']) {
      const v = numField(body.categoryBudgets[cat], 0, 1e9);
      if (v !== undefined) patch.categoryBudgets[cat] = v;
    }
  }
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
  return patch;
}

function servePage(res, file) {
  const html = readFileSync(path.join(ROOT, 'public', file));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  return res.end(html);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const rt = resolveRuntime(req);
    const p = url.pathname;

    if (req.method === 'GET' && p === '/') return servePage(res, 'index.html');
    if (req.method === 'GET' && p === '/verify') return servePage(res, 'verify.html');
    if (req.method === 'GET' && p === '/status') return servePage(res, 'status.html');

    // Verdict badge — always from the CANONICAL ledger (public proof).
    if (req.method === 'GET' && p.startsWith('/badge/') && p.endsWith('.svg')) {
      const hash = decodeURIComponent(p.slice('/badge/'.length, -'.svg'.length)).toLowerCase();
      const entry = canonical.ledger.entries.find((e) => e.hash === hash || e.hash.startsWith(hash));
      res.writeHead(entry ? 200 : 404, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=300' });
      return res.end(badgeSvg(entry || null));
    }

    if (req.method === 'GET' && p === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'agentguard',
        network: 'near-testnet',
        sandbox: rt.sandbox,
        anchorMode: rt.anchor.mode,
        anchorAccount: rt.anchor.account?.accountId || null,
        anchorContract: rt.anchor.dedicatedContractId || null,
        decisions: rt.ledger.entries.length,
        pendingReview: rt.ledger.pendingReview().length,
        chainValid: rt.ledger.verifyChain().ok,
        alertWebhookConfigured: Boolean(process.env.ALERT_WEBHOOK_URL) && !rt.sandbox,
        agents: [...rt.agentPolicies.keys()],
      });
    }

    if (req.method === 'GET' && p === '/api/status') {
      const anchored = rt.ledger.entries.filter((e) => e.anchor?.anchored);
      const last = anchored[anchored.length - 1] || null;
      return sendJson(res, 200, {
        service: 'agentguard',
        network: 'near-testnet',
        sandbox: rt.sandbox,
        startedAt: STARTED_AT,
        uptimeSeconds: Math.round(process.uptime()),
        anchorMode: rt.anchor.mode,
        contractId: rt.anchor.dedicatedContractId || null,
        operatorAccount: rt.anchor.account?.accountId || null,
        contractChainHeight: await contractHeight(rt.anchor.dedicatedContractId),
        decisions: rt.ledger.entries.length,
        chain: rt.ledger.verifyChain(),
        lastAnchored: last ? {
          seq: last.seq, verdict: last.verdict, txHash: last.anchor.txHash,
          explorerUrl: last.anchor.explorerUrl, entryTs: last.ts,
          ageSeconds: Math.max(0, Math.round((Date.now() - Date.parse(last.ts)) / 1000)),
        } : null,
      });
    }

    if (req.method === 'GET' && p === '/api/price') {
      const price = await priceOracle.getPrice();
      return sendJson(res, 200, price
        ? { nearUsd: price.usd, fetchedAt: new Date(price.at).toISOString(), cached: Boolean(price.cached), stale: Boolean(price.stale) }
        : { nearUsd: null, note: 'price feed unavailable — USD estimates hidden, verdicts unaffected' });
    }

    if (req.method === 'GET' && p === '/api/scenarios') return sendJson(res, 200, DEMO_SCENARIOS);
    if (req.method === 'GET' && p === '/api/attacks') return sendJson(res, 200, ATTACK_CHIPS);
    if (req.method === 'GET' && p === '/api/stats') {
      return sendJson(res, 200, { sandbox: rt.sandbox, stats: rt.ledger.stats(), trust: rt.ledger.counterpartyTrust() });
    }

    if (req.method === 'GET' && p === '/api/agents') {
      return sendJson(res, 200, [...rt.agentPolicies.entries()].map(([id, pol]) => ({
        id, label: agentLabel(id), policy: effectivePolicy(rt, id), reputation: rt.ledger.reputation(id),
      })));
    }

    if (req.method === 'GET' && p === '/api/policy') {
      const agent = knownAgent(rt, url.searchParams.get('agent') || DEFAULT_AGENT);
      return sendJson(res, 200, effectivePolicy(rt, agent));
    }
    if (req.method === 'POST' && p === '/api/policy') {
      const body = await readBody(req);
      const agent = knownAgent(rt, body.agent || DEFAULT_AGENT);
      const base = rt.agentPolicies.get(agent);
      rt.agentPolicies.set(agent, { ...base, ...coercePolicyPatch(body, base) });
      return sendJson(res, 200, effectivePolicy(rt, agent));
    }
    if (req.method === 'POST' && p === '/api/policy/impact') {
      const body = await readBody(req);
      const agent = knownAgent(rt, body.agent || DEFAULT_AGENT);
      const base = rt.agentPolicies.get(agent);
      const candidate = { ...base, ...coercePolicyPatch(body.policy || body, base) };
      const limit = Math.min(200, Math.max(1, Number(body.limit) || 20));
      const mine = rt.ledger.entries.filter((e) => e.agent === agent).slice(-limit);
      const candidateFull = { ...candidate, blockedDestinations: [...candidate.blockedDestinations, ...rt.blocklist.destinations()] };
      return sendJson(res, 200, { agent, ...summarizeFlips(rt.ledger, mine, candidateFull) });
    }

    if (req.method === 'POST' && p === '/api/propose') {
      const body = await readBody(req);
      const scenario = body.scenario && DEMO_SCENARIOS[body.scenario] ? DEMO_SCENARIOS[body.scenario] : null;
      const instruction = scenario ? scenario.instruction : String(body.instruction || '');
      if (!instruction) return sendJson(res, 400, { error: 'instruction or scenario required' });
      if (scenario?.agents) {
        const results = [];
        for (const agentId of scenario.agents) results.push(await guardAndRecord(rt, instruction, agentId));
        return sendJson(res, 200, { results });
      }
      const out = await guardAndRecord(rt, instruction, body.agent || DEFAULT_AGENT);
      return sendJson(res, 200, out);
    }

    if (req.method === 'POST' && p === '/api/simulate') {
      const body = await readBody(req);
      const scenario = body.scenario && DEMO_SCENARIOS[body.scenario] ? DEMO_SCENARIOS[body.scenario] : null;
      const instruction = scenario ? scenario.instruction : String(body.instruction || '');
      if (!instruction) return sendJson(res, 400, { error: 'instruction or scenario required' });
      const agent = knownAgent(rt, body.agent || DEFAULT_AGENT);
      const base = rt.agentPolicies.get(agent);
      const override = body.policy ? coercePolicyPatch(body.policy, base) : null;
      return sendJson(res, 200, await simulate(rt, instruction, agent, override));
    }

    if (req.method === 'POST' && p === '/api/replay') {
      const body = await readBody(req);
      const entry = rt.ledger.entries.find((e) => e.seq === Number(body.seq));
      if (!entry) return sendJson(res, 404, { error: 'no such decision' });
      if (entry.kind === 'resolution') return sendJson(res, 400, { error: 'resolution entries cannot be replayed — replay the original decision' });
      const agent = knownAgent(rt, body.agent || entry.agent);
      const policy = effectivePolicy(rt, agent);
      return sendJson(res, 200, replayProposal(entry, policy, rt.ledger.contextBefore(entry, policy.graduationThreshold ?? 3)));
    }

    if (req.method === 'POST' && p === '/api/review') {
      const body = await readBody(req);
      const seq = Number(body.seq);
      if (!Number.isInteger(seq) || !['approve', 'deny'].includes(body.decision)) {
        return sendJson(res, 400, { error: 'body must be {seq: <held decision number>, decision: "approve"|"deny", note?}' });
      }
      const out = await resolveReview(rt, seq, body.decision, body.note);
      if (out.error) return sendJson(res, out.code, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (req.method === 'GET' && p === '/api/blocklist') {
      const agent = knownAgent(rt, url.searchParams.get('agent') || DEFAULT_AGENT);
      return sendJson(res, 200, { builtIn: rt.agentPolicies.get(agent).blockedDestinations, reported: rt.blocklist.reports });
    }
    if (req.method === 'POST' && p === '/api/blocklist') {
      const body = await readBody(req);
      try {
        const { report, added } = rt.blocklist.add(body.destination, body.evidence);
        return sendJson(res, added ? 201 : 200, { report, added, effectiveBlocked: effectivePolicy(rt, DEFAULT_AGENT).blockedDestinations });
      } catch (e) {
        return sendJson(res, 400, { error: String(e.message || e) });
      }
    }

    if (req.method === 'GET' && p === '/api/beneficiaries') {
      return sendJson(res, 200, { beneficiaries: rt.beneficiaries.list() });
    }
    if (req.method === 'POST' && p === '/api/beneficiaries') {
      const body = await readBody(req);
      try {
        const { item, updated } = rt.beneficiaries.add(body.account, { note: body.note, capNear: body.capNear });
        return sendJson(res, updated ? 200 : 201, { beneficiary: item, updated });
      } catch (e) {
        return sendJson(res, 400, { error: String(e.message || e) });
      }
    }
    if (req.method === 'DELETE' && p === '/api/beneficiaries') {
      const body = await readBody(req);
      return sendJson(res, 200, { removed: rt.beneficiaries.remove(body.account) });
    }

    if (req.method === 'GET' && p === '/api/standing') {
      return sendJson(res, 200, { standing: rt.standing });
    }
    if (req.method === 'POST' && p === '/api/standing') {
      const body = await readBody(req);
      try {
        const si = createStandingInstruction(body);
        rt.standing.push(si);
        return sendJson(res, 201, { standing: si });
      } catch (e) {
        return sendJson(res, 400, { error: String(e.message || e) });
      }
    }
    if (req.method === 'POST' && p.startsWith('/api/standing/') && p.endsWith('/run')) {
      const id = decodeURIComponent(p.slice('/api/standing/'.length, -'/run'.length));
      const si = rt.standing.find((s) => s.id === id);
      if (!si) return sendJson(res, 404, { error: 'no such standing instruction' });
      const body = await readBody(req).catch(() => ({}));
      const n = si.occurrencesRun + 1;
      // Screen the occurrence through the full guard path so it is judged
      // by the CURRENT policy + context, then recorded like any decision.
      const instruction = `Pay ${si.amount} NEAR to ${si.to}${si.memo ? ` — ${si.memo}` : ''} (standing instruction ${si.id}, occurrence ${n})`;
      const out = await guardAndRecord(rt, instruction, body.agent || DEFAULT_AGENT);
      si.occurrencesRun = n;
      return sendJson(res, 200, { standingId: si.id, occurrence: n, ...out });
    }

    if (req.method === 'GET' && (p === '/api/audit-bundle' || p === '/api/ledger/export')) {
      const bundle = buildAuditBundle(rt.ledger, {
        contractId: rt.anchor.dedicatedContractId || null,
        operatorAccount: rt.anchor.account?.accountId || null,
      });
      const body = JSON.stringify(bundle, null, 2);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="agentguard-audit-bundle.json"',
        'Content-Length': Buffer.byteLength(body),
      });
      return res.end(body);
    }

    if (req.method === 'POST' && p === '/api/ledger/import') {
      const body = await readBody(req);
      const bundle = body.bundle || body;
      const check = verifyAuditBundle(bundle);
      if (!check.ok) return sendJson(res, 400, { error: 'bundle failed verification — import rejected', details: check.errors });
      if (!rt.sandbox && rt.ledger.entries.length > 0) {
        return sendJson(res, 409, { error: 'import into a non-empty canonical ledger is refused; use a judge sandbox session or an empty ledger' });
      }
      const { ledger: imported } = Ledger.fromEntries(bundle.entries, rt.sandbox ? null : rt.ledger.filePath);
      rt.ledger = imported;
      return sendJson(res, 200, { imported: check.entryCount, chainTip: check.chainTip });
    }

    if (req.method === 'GET' && p === '/api/report') {
      return sendJson(res, 200, {
        generatedAt: new Date().toISOString(),
        service: 'agentguard',
        network: 'near-testnet',
        sandbox: rt.sandbox,
        anchor: { mode: rt.anchor.mode, account: rt.anchor.account?.accountId || null, contract: rt.anchor.dedicatedContractId || null },
        chain: rt.ledger.verifyChain(),
        stats: rt.ledger.stats(),
        trust: rt.ledger.counterpartyTrust(),
        agents: [...rt.agentPolicies.entries()].map(([id]) => ({
          id, label: agentLabel(id), policy: effectivePolicy(rt, id), reputation: rt.ledger.reputation(id),
        })),
        beneficiaries: rt.beneficiaries.list(),
        pendingReview: rt.ledger.pendingReview(),
        blocklist: { reported: rt.blocklist.reports },
        entries: rt.ledger.entries,
      });
    }

    if (req.method === 'GET' && p === '/api/decisions') {
      const agent = knownAgent(rt, url.searchParams.get('agent') || DEFAULT_AGENT);
      const price = await priceOracle.getPrice();
      return sendJson(res, 200, {
        sandbox: rt.sandbox,
        chain: rt.ledger.verifyChain(),
        stats: rt.ledger.stats(),
        trust: rt.ledger.counterpartyTrust(),
        reputations: Object.fromEntries([...rt.agentPolicies.keys()].map((id) => [id, rt.ledger.reputation(id)])),
        categories: rt.ledger.categorySpendThisMonth(agent),
        categoryBudgets: effectivePolicy(rt, agent).categoryBudgets,
        spentToday: rt.ledger.spentToday(new Date(), agent),
        pendingReview: rt.ledger.pendingReview(),
        nearUsd: price ? price.usd : null,
        entries: [...rt.ledger.entries].reverse(),
      });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    return sendJson(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`AgentGuard running at http://localhost:${PORT} (anchor mode: ${canonical.anchor.mode})`);
});
