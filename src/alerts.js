// Block / hold alert webhooks.
//
// When AgentGuard stops a payment (BLOCKED) or holds one for a human
// (REVIEW), the human should hear about it immediately — not discover it in
// a log later. For every such verdict the server composes a webhook payload;
// if ALERT_WEBHOOK_URL is configured the payload is POSTed there, otherwise
// it is display-only (the demo UI shows exactly what would be sent).

export function buildAlertPayload(entry, { contractId = null } = {}) {
  return {
    event: 'agentguard.verdict',
    alert: entry.verdict, // 'BLOCKED' | 'REVIEW'
    seq: entry.seq,
    ts: entry.ts,
    agent: entry.agent,
    destination: entry.to,
    amountNear: entry.amount,
    riskScore: entry.riskScore,
    reasons: entry.reasons,
    entryHash: entry.hash,
    anchorTx: entry.anchor?.anchored ? entry.anchor.txHash : null,
    anchorExplorer: entry.anchor?.anchored ? entry.anchor.explorerUrl : null,
    contract: contractId,
    action: entry.verdict === 'BLOCKED'
      ? 'Payment stopped by AgentGuard. No action needed unless the agent was expected to pay.'
      : 'Payment held by AgentGuard. A human must approve or deny it in the review inbox.',
  };
}

// Fire-and-forget delivery for the verdict path. Composing the payload and
// showing it in the UI is synchronous; POSTing it must never delay a
// verdict — a dead webhook would otherwise add its full timeout (~3 s,
// plus RPC time) to every BLOCKED/REVIEW response. The POST proceeds in
// the background; its outcome is swallowed by design (deliverAlert itself
// already never throws — the catch here is belt-and-braces). Returns the
// receipt the UI shows immediately.
const inFlightDeliveries = new Set();
export function deliverAlertInBackground(payload, opts = {}) {
  const p = Promise.resolve()
    .then(() => deliverAlert(payload, opts))
    .catch(() => null);
  inFlightDeliveries.add(p);
  p.finally(() => inFlightDeliveries.delete(p));
  return {
    mode: 'queued',
    delivered: null,
    note: 'Alert payload composed and shown here; webhook delivery fired in the background, so a slow or dead webhook never delays the verdict.',
  };
}

// Deliver the payload if a webhook URL is set. Never throws: alerting must
// not break the verdict path. Returns a delivery receipt for the UI.
export async function deliverAlert(payload, { url = process.env.ALERT_WEBHOOK_URL || null, fetchFn = fetch, timeoutMs = 3000, displayOnlyReason = null } = {}) {
  if (displayOnlyReason) {
    return { mode: 'display-only', delivered: false, note: displayOnlyReason };
  }
  if (!url) {
    return { mode: 'display-only', delivered: false, note: 'No ALERT_WEBHOOK_URL configured — payload composed and shown, not sent.' };
  }
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { mode: 'posted', delivered: Boolean(res.ok), status: res.status, note: res.ok ? `POSTed to the configured webhook (HTTP ${res.status}).` : `Webhook answered HTTP ${res.status}.` };
  } catch (e) {
    return { mode: 'failed', delivered: false, error: String(e.message || e).slice(0, 200), note: 'Webhook POST failed — payload still shown here and recorded with the decision.' };
  }
}
