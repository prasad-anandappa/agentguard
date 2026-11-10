// AgentGuard policy engine.
//
// Pure, deterministic, dependency-free. Every payment an AI agent proposes is
// evaluated against a human-set policy BEFORE it can execute. The engine
// returns a verdict, a risk score, human-readable reasons, and a step-by-step
// rule trace — the same reasons and trace that end up in the anchored
// decision log and the UI's "Why this verdict" panel.
//
// Amounts are NEAR (testnet demo asset). Internally all money is handled as
// integer hundredths of NEAR to avoid floating-point drift.

export const VERDICT = { APPROVED: 'APPROVED', BLOCKED: 'BLOCKED', REVIEW: 'REVIEW' };

export const DEFAULT_POLICY = {
  perTxLimit: 100, // NEAR
  dailyLimit: 250, // NEAR
  requireAllowlist: false,
  allowedDestinations: [],
  blockedDestinations: [
    'double-your-near.testnet',
    'near-prize-claims.testnet',
    'wallet-verify-now.testnet',
  ],
  // Destinations the human has paid before / trusts (used for lookalike checks)
  knownPayees: ['cloud-provider.testnet', 'api-market.testnet', 'data-oracle.testnet'],
  // A first-time destination asking for more than this gets flagged for review risk
  firstTimeReviewThreshold: 25, // NEAR
  // A first-time destination asking for more than this is blocked outright —
  // the first-time + large combo is the classic drain opening move.
  firstTimeBlockThreshold: 90, // NEAR
  // Risk score at or above this blocks the payment
  riskBlockThreshold: 50,
  // Risk score at or above this (but below the block threshold, with no hard
  // rule broken) holds the payment for a human decision — the "warn" tier.
  reviewThreshold: 20,
  // Counterparty trust graduation: after this many consecutive clean
  // (finally APPROVED) payments, a counterparty is treated as trusted and
  // first-time findings no longer fire for it.
  graduationThreshold: 3,
  // Velocity / burst detection over a rolling window.
  velocityWindowMinutes: 10,
  velocityMaxCount: 3, // payments to one counterparty inside the window
  velocityMaxOutflow: 150, // NEAR approved inside the window, all destinations
  velocityAction: 'REVIEW', // 'REVIEW' | 'BLOCK'
  // Monthly category budgets (NEAR). Categories are inferred from the memo.
  categoryBudgets: { hosting: 1000, dev: 1000, tools: 1000, other: 1000 },
};

const toCents = (n) => Math.round(Number(n) * 100);

// --- Memo categories (deliberately simple keyword inference) ----------------

export const CATEGORIES = ['hosting', 'dev', 'tools', 'other'];
const CATEGORY_PATTERNS = [
  ['hosting', /hosting|server|vps|domain|cloud bill|infrastructure/i],
  ['dev', /\bapi\b|data|feed|developer|\bci\b|build|oracle/i],
  ['tools', /tool|saas|software|licen[cs]e|subscription|app\b/i],
];

export function categoryOf(memo) {
  const m = String(memo || '');
  for (const [cat, re] of CATEGORY_PATTERNS) if (re.test(m)) return cat;
  return 'other';
}

// --- Scam / abuse pattern screening ---------------------------------------
// Each detector returns findings: { code, label, severity, points }.
// severity 'hard' blocks regardless of score; 'risk' adds to the risk score.
const MEMO_PATTERNS = [
  { code: 'DOUBLE_YOUR_MONEY', re: /double your|2x your|guaranteed (return|profit)|risk[- ]free profit/i, label: 'Memo promises guaranteed/doubled returns — classic advance-fee scam', severity: 'hard', points: 60 },
  { code: 'PRIZE_CLAIM', re: /claim (your )?(prize|reward|airdrop|winnings)|you (have )?won/i, label: 'Memo is a prize/airdrop claim lure', severity: 'hard', points: 60 },
  { code: 'SEED_PHRASE', re: /seed phrase|recovery phrase|private key|validate your wallet|verify your wallet/i, label: 'Memo asks for wallet verification / seed phrase — phishing pattern', severity: 'hard', points: 70 },
  { code: 'URGENCY_PRESSURE', re: /urgent|immediately|act now|expires in|last chance|within \d+ minutes/i, label: 'Memo uses urgency pressure to rush the payment', severity: 'risk', points: 20 },
  { code: 'AUTHORITY_IMPERSONATION', re: /\b(irs|tax authority|police|court|customs|bank security)\b/i, label: 'Memo impersonates an authority (tax/police/bank)', severity: 'risk', points: 30 },
  { code: 'GIFT_CARD_RAKE', re: /gift cards?|steam card|itunes card/i, label: 'Memo routes value through gift cards — laundering pattern', severity: 'risk', points: 30 },
];

export function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}

export function screenProposal(proposal, policy, context) {
  const findings = [];
  const to = String(proposal.to || '').toLowerCase();
  const memo = String(proposal.memo || '');

  if (policy.blockedDestinations.map((d) => d.toLowerCase()).includes(to)) {
    findings.push({ code: 'BLOCKLISTED_DESTINATION', label: `Destination ${to} is on the human's blocklist`, severity: 'hard', points: 80 });
  }

  for (const p of MEMO_PATTERNS) {
    if (p.re.test(memo) || p.re.test(to)) {
      findings.push({ code: p.code, label: p.label, severity: p.severity, points: p.points });
    }
  }

  // Lookalike of a known payee: 1-2 edits away but not identical.
  for (const payee of policy.knownPayees) {
    const known = payee.toLowerCase();
    if (to !== known) {
      const d = levenshtein(to, known);
      if (d >= 1 && d <= 2) {
        findings.push({ code: 'LOOKALIKE_DESTINATION', label: `Destination ${to} looks like known payee ${known} (${d} character difference) — typosquat pattern`, severity: 'hard', points: 55 });
      }
    }
  }

  // Random-looking destination account (long, digit-heavy) — burner pattern.
  const localPart = to.split('.')[0] || '';
  const digits = (localPart.match(/\d/g) || []).length;
  if (localPart.length >= 18 && digits >= 6) {
    findings.push({ code: 'BURNER_DESTINATION', label: 'Destination account looks auto-generated (long, digit-heavy) — burner wallet pattern', severity: 'risk', points: 25 });
  }

  // "First-time" means: this guard has never approved a payment to the
  // destination AND the counterparty has not graduated to trusted.
  const seen = context.seenDestinations || new Set();
  const trusted = context.trustedDestinations || new Set();
  const isNew = !seen.has(to) && !trusted.has(to);
  const amountC = toCents(proposal.amount);

  // First-time + large combo: escalates straight to BLOCK, replacing the
  // softer first-time review finding (the two never stack).
  if (isNew && Number.isFinite(policy.firstTimeBlockThreshold) && amountC > toCents(policy.firstTimeBlockThreshold)) {
    findings.push({ code: 'FIRST_TIME_BLOCK', label: `First payment ever to ${to} and above the ${policy.firstTimeBlockThreshold} NEAR first-time block threshold — first-time + large is the classic drain opening`, severity: 'hard', points: 80 });
  } else if (isNew && amountC > toCents(policy.firstTimeReviewThreshold)) {
    findings.push({ code: 'FIRST_TIME_LARGE', label: `First payment ever to ${to} and above the ${policy.firstTimeReviewThreshold} NEAR first-time review threshold`, severity: 'risk', points: 20 });
  }

  // Drain pattern: first-time destination asking for ~everything left today.
  const remainingDaily = toCents(policy.dailyLimit) - toCents(context.spentToday || 0);
  if (isNew && remainingDaily > 0 && amountC >= 0.9 * remainingDaily && amountC > toCents(policy.firstTimeReviewThreshold)) {
    findings.push({ code: 'DRAIN_PATTERN', label: 'Amount would consume ~all of today\'s remaining budget to a first-time destination — drain pattern', severity: 'hard', points: 65 });
  }

  // Velocity / burst detection over a rolling window. context.recentPayments
  // is a raw list of prior attempts [{ to, amount, ts (ms epoch), verdict }]
  // (final outcomes; verdicts APPROVED or REVIEW count as money-moving
  // attempts, APPROVED amounts count as outflow). The window edge is
  // inclusive: an attempt exactly velocityWindowMinutes old still counts.
  const recent = Array.isArray(context.recentPayments) ? context.recentPayments : [];
  if (recent.length) {
    const now = Number.isFinite(context.now) ? context.now : Date.now();
    const windowMs = Math.max(1, Number(policy.velocityWindowMinutes) || 10) * 60_000;
    const inWindow = recent.filter((p) => p && Number.isFinite(p.ts) && now - p.ts <= windowMs && now - p.ts >= 0);
    const attempts = inWindow.filter((p) => p.verdict === 'APPROVED' || p.verdict === 'REVIEW');
    const sev = policy.velocityAction === 'BLOCK' ? 'hard' : 'risk';
    const pts = sev === 'hard' ? 65 : 30;
    const sameDest = attempts.filter((p) => String(p.to || '').toLowerCase() === to).length;
    if (Number.isFinite(policy.velocityMaxCount) && sameDest + 1 >= policy.velocityMaxCount) {
      findings.push({ code: 'VELOCITY_COUNT', label: `Burst: this is payment #${sameDest + 1} to ${to} within ${policy.velocityWindowMinutes} minutes (limit ${policy.velocityMaxCount}) — velocity check ${policy.velocityAction === 'BLOCK' ? 'blocks' : 'escalates'}`, severity: sev, points: pts });
    }
    const outflowC = inWindow
      .filter((p) => p.verdict === 'APPROVED')
      .reduce((s, p) => s + toCents(p.amount), 0);
    if (Number.isFinite(policy.velocityMaxOutflow) && outflowC + amountC > toCents(policy.velocityMaxOutflow)) {
      findings.push({ code: 'VELOCITY_OUTFLOW', label: `Burst outflow: ${(outflowC) / 100} NEAR already approved in the last ${policy.velocityWindowMinutes} minutes; this payment would exceed the ${policy.velocityMaxOutflow} NEAR velocity outflow cap`, severity: sev, points: pts });
    }
  }

  // Findings supplied by external screeners (e.g. the on-chain counterparty
  // check) merge into the same scoring, deduped by code.
  if (Array.isArray(context.extraFindings)) {
    for (const f of context.extraFindings) {
      if (f && f.code && !findings.some((x) => x.code === f.code)) findings.push(f);
    }
  }

  return findings;
}

// --- Main evaluation --------------------------------------------------------
// Returns { verdict, riskScore, reasons, findings, trace }.
// trace: ordered steps { rule, outcome: 'pass'|'fired'|'info', detail, points? }
// — the audit trail behind the verdict, rendered by the UI and stored with
// the ledger entry.
export function evaluateProposal(proposal, policy = DEFAULT_POLICY, context = {}) {
  const reasons = [];
  const trace = [];
  const amountC = toCents(proposal.amount);
  const spentTodayC = toCents(context.spentToday || 0);
  let hardBlock = false;

  if (!proposal.to || typeof proposal.to !== 'string') {
    trace.push({ rule: 'destination', outcome: 'fired', detail: 'Proposal has no valid destination' });
    return { verdict: VERDICT.BLOCKED, riskScore: 100, reasons: ['Proposal has no valid destination'], findings: [], trace };
  }
  trace.push({ rule: 'destination', outcome: 'pass', detail: `Destination ${String(proposal.to).toLowerCase()}` });
  if (!Number.isFinite(amountC) || amountC <= 0) {
    trace.push({ rule: 'amount', outcome: 'fired', detail: 'Proposal amount is missing or not positive' });
    return { verdict: VERDICT.BLOCKED, riskScore: 100, reasons: ['Proposal amount is missing or not positive'], findings: [], trace };
  }
  trace.push({ rule: 'amount', outcome: 'pass', detail: `Amount ${proposal.amount} NEAR` });

  if (amountC > toCents(policy.perTxLimit)) {
    hardBlock = true;
    const msg = `Amount ${proposal.amount} NEAR exceeds the per-transaction limit of ${policy.perTxLimit} NEAR`;
    reasons.push(msg);
    trace.push({ rule: 'per-transaction-limit', outcome: 'fired', detail: msg });
  } else {
    trace.push({ rule: 'per-transaction-limit', outcome: 'pass', detail: `${proposal.amount} NEAR ≤ ${policy.perTxLimit} NEAR per-transaction limit` });
  }
  if (spentTodayC + amountC > toCents(policy.dailyLimit)) {
    hardBlock = true;
    const msg = `Amount would bring today's total to ${(spentTodayC + amountC) / 100} NEAR, over the daily limit of ${policy.dailyLimit} NEAR`;
    reasons.push(msg);
    trace.push({ rule: 'daily-limit', outcome: 'fired', detail: msg });
  } else {
    trace.push({ rule: 'daily-limit', outcome: 'pass', detail: `Today's approved total would be ${(spentTodayC + amountC) / 100} of ${policy.dailyLimit} NEAR` });
  }

  // Per-beneficiary cap (beneficiary book): a saved cap for this destination
  // overrides the global per-transaction limit whenever it is stricter. It
  // can only ever tighten, never loosen.
  const cap = context.beneficiaryCap;
  if (Number.isFinite(cap) && cap !== null && cap !== undefined) {
    if (amountC > toCents(cap)) {
      hardBlock = true;
      const msg = `Amount ${proposal.amount} NEAR exceeds the beneficiary cap of ${cap} NEAR set for ${String(proposal.to).toLowerCase()} in the beneficiary book`;
      reasons.push(msg);
      trace.push({ rule: 'beneficiary-cap', outcome: 'fired', detail: msg });
    } else {
      trace.push({ rule: 'beneficiary-cap', outcome: 'pass', detail: `${proposal.amount} NEAR ≤ beneficiary cap of ${cap} NEAR for this destination` });
    }
  }

  // Monthly category budget, enforced alongside the global limits.
  const category = categoryOf(proposal.memo);
  const catCap = policy.categoryBudgets ? policy.categoryBudgets[category] : undefined;
  if (Number.isFinite(catCap)) {
    const spentCatC = toCents((context.spentThisMonthByCategory || {})[category] || 0);
    if (spentCatC + amountC > toCents(catCap)) {
      hardBlock = true;
      const msg = `Amount would bring this month's "${category}" category spend to ${(spentCatC + amountC) / 100} NEAR, over its monthly budget of ${catCap} NEAR`;
      reasons.push(msg);
      trace.push({ rule: 'category-budget', outcome: 'fired', detail: msg });
    } else {
      trace.push({ rule: 'category-budget', outcome: 'pass', detail: `Category "${category}": month-to-date ${(spentCatC) / 100} + ${proposal.amount} ≤ ${catCap} NEAR monthly budget` });
    }
  }

  if (policy.requireAllowlist && !policy.allowedDestinations.map((d) => d.toLowerCase()).includes(String(proposal.to).toLowerCase())) {
    hardBlock = true;
    const msg = `Destination ${proposal.to} is not on the allowlist (allowlist mode is on)`;
    reasons.push(msg);
    trace.push({ rule: 'allowlist', outcome: 'fired', detail: msg });
  } else if (policy.requireAllowlist) {
    trace.push({ rule: 'allowlist', outcome: 'pass', detail: 'Destination is on the allowlist' });
  }

  const findings = screenProposal(proposal, policy, context);
  const riskScore = Math.min(100, findings.reduce((s, f) => s + f.points, 0));
  for (const f of findings) {
    reasons.push(f.label);
    trace.push({ rule: f.code, outcome: 'fired', detail: f.label, points: f.points, severity: f.severity });
    if (f.severity === 'hard') hardBlock = true;
  }
  if (!findings.length) {
    trace.push({ rule: 'screening', outcome: 'pass', detail: 'No scam, lookalike, first-time, drain or velocity patterns detected' });
  }
  trace.push({ rule: 'risk-score', outcome: 'info', detail: `Risk score ${riskScore} / 100 (review band ≥ ${policy.reviewThreshold ?? 20}, block at ≥ ${policy.riskBlockThreshold})`, points: riskScore });

  if (!hardBlock && riskScore >= policy.riskBlockThreshold) {
    hardBlock = true;
    const msg = `Combined risk score ${riskScore} is at/over the block threshold of ${policy.riskBlockThreshold}`;
    reasons.push(msg);
    trace.push({ rule: 'risk-threshold', outcome: 'fired', detail: msg });
  }

  // Warn tier: no hard rule broken, but the risk score is high enough that a
  // human must decide before the agent may pay (track brief: the wrapper
  // "asks a human when it's warn").
  if (!hardBlock && riskScore >= (policy.reviewThreshold ?? 20)) {
    const msg = `Risk score ${riskScore} is in the human-review band (${policy.reviewThreshold ?? 20}–${policy.riskBlockThreshold - 1}) — held for a human decision`;
    reasons.push(msg);
    trace.push({ rule: 'verdict-band', outcome: 'info', detail: `Verdict REVIEW — ${msg}` });
    return { verdict: VERDICT.REVIEW, riskScore, reasons, findings, trace };
  }

  const verdict = hardBlock ? VERDICT.BLOCKED : VERDICT.APPROVED;
  trace.push({ rule: 'verdict-band', outcome: 'info', detail: hardBlock ? 'Verdict BLOCKED — at least one hard rule fired' : 'Verdict APPROVED — all rules passed and risk is below the review band' });
  return {
    verdict,
    riskScore,
    reasons: reasons.length ? reasons : ['Within all limits and no risk patterns detected'],
    findings,
    trace,
  };
}
