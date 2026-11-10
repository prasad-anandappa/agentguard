// AgentGuard server — zero-framework Node http server.
// Serves the demo UI and the JSON API the UI (and judges) can drive directly.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_POLICY, evaluateProposal } from './policy.js';
import { Ledger } from './ledger.js';
import { anchorFromEnv } from './anchor.js';
import { proposePayment, DEMO_SCENARIOS } from './agent.js';

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
const anchor = await anchorFromEnv();
let policy = { ...DEFAULT_POLICY };

const AGENT_ID = 'agentguard-demo-agent';

async function guardAndRecord(instruction) {
  const { proposal, via } = await proposePayment(instruction);
  const context = { spentToday: ledger.spentToday(), seenDestinations: ledger.seenDestinations() };
  const result = evaluateProposal(proposal, policy, context);
  const entry = ledger.append({ agent: AGENT_ID, proposal, verdict: result.verdict, riskScore: result.riskScore, reasons: result.reasons });
  entry.anchor = await anchor.anchorEntry(entry);
  ledger.setAnchor(entry.seq, entry.anchor);
  return { entry, via, policy: { perTxLimit: policy.perTxLimit, dailyLimit: policy.dailyLimit } };
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
        decisions: ledger.entries.length,
        chainValid: ledger.verifyChain().ok,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/scenarios') {
      return sendJson(res, 200, DEMO_SCENARIOS);
    }
    if (req.method === 'GET' && url.pathname === '/api/policy') {
      return sendJson(res, 200, policy);
    }
    if (req.method === 'POST' && url.pathname === '/api/policy') {
      const body = await readBody(req);
      const num = (v, min, max) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : undefined);
      policy = {
        ...policy,
        perTxLimit: num(body.perTxLimit, 0.01, 1e6) ?? policy.perTxLimit,
        dailyLimit: num(body.dailyLimit, 0.01, 1e6) ?? policy.dailyLimit,
        requireAllowlist: typeof body.requireAllowlist === 'boolean' ? body.requireAllowlist : policy.requireAllowlist,
      };
      return sendJson(res, 200, policy);
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
    if (req.method === 'GET' && url.pathname === '/api/decisions') {
      return sendJson(res, 200, {
        chain: ledger.verifyChain(),
        reputation: ledger.reputation(AGENT_ID),
        spentToday: ledger.spentToday(),
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
