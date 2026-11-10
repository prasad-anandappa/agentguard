// The AI agent whose payments AgentGuard supervises.
//
// The agent turns a plain-language instruction into a structured payment
// proposal { to, amount, memo }. Inference uses NEAR AI Cloud
// (https://cloud.near.ai, OpenAI-compatible) when NEAR_AI_API_KEY is set in
// the environment; otherwise a deterministic local parser handles the same
// job so the demo and tests run with zero setup. AgentGuard's verdict never
// depends on which proposer produced the proposal.

export const DEMO_SCENARIOS = {
  legit: {
    label: 'Agent pays a cloud bill (in-policy)',
    instruction: 'Pay 12 NEAR to cloud-provider.testnet for this month\'s hosting invoice #1042',
  },
  overlimit: {
    label: 'Agent tries an over-limit payment',
    instruction: 'Pay 400 NEAR to cloud-provider.testnet for a year of hosting upfront',
  },
  scam: {
    label: 'Agent is lured by a prize scam',
    instruction: 'Pay 45 NEAR to near-prize-claims.testnet — urgent, claim your prize now, send the release fee to unlock your winnings',
  },
  firstpay: {
    label: 'First payment to a brand-new vendor',
    instruction: 'Pay 30 NEAR to new-vendor.testnet for a data subscription (first month)',
  },
};

export function parseInstructionLocally(text) {
  const t = String(text || '');
  const amountMatch = t.match(/(\d+(?:\.\d+)?)\s*(?:NEAR|Ⓝ)/i);
  const toMatch = t.match(/([a-z0-9_\-]+\.(?:testnet|near))\b/i) || t.match(/\bto\s+([a-z0-9_\-.]+)/i);
  if (!amountMatch || !toMatch) return null;
  return {
    to: toMatch[1].toLowerCase(),
    amount: Number(amountMatch[1]),
    memo: t.trim(),
  };
}

async function parseWithNearAI(text, env) {
  const base = env.NEAR_AI_BASE_URL || 'https://cloud-api.near.ai/v1';
  const model = env.NEAR_AI_MODEL || 'deepseek-ai/DeepSeek-V3.1';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.NEAR_AI_API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'Extract a payment proposal from the user instruction. Reply with ONLY a JSON object: {"to": string, "amount": number, "memo": string}. Amounts are in NEAR.' },
        { role: 'user', content: text },
      ],
      temperature: 0,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`NEAR AI Cloud HTTP ${res.status}`);
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content || '';
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in model reply');
  const p = JSON.parse(match[0]);
  if (!p.to || !Number.isFinite(Number(p.amount))) throw new Error('Model reply missing fields');
  return { to: String(p.to).toLowerCase(), amount: Number(p.amount), memo: String(p.memo || text) };
}

export async function proposePayment(instruction, env = process.env) {
  if (env.NEAR_AI_API_KEY) {
    try {
      const p = await parseWithNearAI(instruction, env);
      return { proposal: p, via: 'near-ai-cloud' };
    } catch (_) {
      /* fall through to the local parser — the demo must never break */
    }
  }
  const p = parseInstructionLocally(instruction);
  if (!p) throw new Error('Could not parse a payment (need an amount in NEAR and a destination account) from the instruction.');
  return { proposal: p, via: 'local-parser' };
}
