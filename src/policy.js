// AgentGuard policy engine.
//
// Pure, deterministic, dependency-free. Every payment an AI agent proposes is
// evaluated against a human-set policy BEFORE it can execute. The engine
// returns a verdict, a risk score, and human-readable reasons for every check
// that fired — the same reasons that end up in the anchored decision log.
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
  // Risk score at or above this blocks the payment
  riskBlockThreshold: 50,
  // Risk score at or above this (but below the block threshold, with no hard
  // rule broken) holds the payment for a human decision — the "warn" tier.
  reviewThreshold: 20,
};

const toCents = (n) => Math.round(Number(n) * 100);

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

  // First-time destination + meaningful amount.
  const seen = context.seenDestinations || new Set();
  const amountC = toCents(proposal.amount);
  if (!seen.has(to) && amountC > toCents(policy.firstTimeReviewThreshold)) {
    findings.push({ code: 'FIRST_TIME_LARGE', label: `First payment ever to ${to} and above the ${policy.firstTimeReviewThreshold} NEAR first-time review threshold`, severity: 'risk', points: 20 });
  }

  // Drain pattern: first-time destination asking for ~everything left today.
  const remainingDaily = toCents(policy.dailyLimit) - toCents(context.spentToday || 0);
  if (!seen.has(to) && remainingDaily > 0 && amountC >= 0.9 * remainingDaily && amountC > toCents(policy.firstTimeReviewThreshold)) {
    findings.push({ code: 'DRAIN_PATTERN', label: 'Amount would consume ~all of today\'s remaining budget to a first-time destination — drain pattern', severity: 'hard', points: 65 });
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
export function evaluateProposal(proposal, policy = DEFAULT_POLICY, context = {}) {
  const reasons = [];
  const amountC = toCents(proposal.amount);
  const spentTodayC = toCents(context.spentToday || 0);
  let hardBlock = false;

  if (!proposal.to || typeof proposal.to !== 'string') {
    return { verdict: VERDICT.BLOCKED, riskScore: 100, reasons: ['Proposal has no valid destination'], findings: [] };
  }
  if (!Number.isFinite(amountC) || amountC <= 0) {
    return { verdict: VERDICT.BLOCKED, riskScore: 100, reasons: ['Proposal amount is missing or not positive'], findings: [] };
  }

  if (amountC > toCents(policy.perTxLimit)) {
    hardBlock = true;
    reasons.push(`Amount ${proposal.amount} NEAR exceeds the per-transaction limit of ${policy.perTxLimit} NEAR`);
  }
  if (spentTodayC + amountC > toCents(policy.dailyLimit)) {
    hardBlock = true;
    reasons.push(`Amount would bring today's total to ${(spentTodayC + amountC) / 100} NEAR, over the daily limit of ${policy.dailyLimit} NEAR`);
  }
  if (policy.requireAllowlist && !policy.allowedDestinations.map((d) => d.toLowerCase()).includes(String(proposal.to).toLowerCase())) {
    hardBlock = true;
    reasons.push(`Destination ${proposal.to} is not on the allowlist (allowlist mode is on)`);
  }

  const findings = screenProposal(proposal, policy, context);
  const riskScore = Math.min(100, findings.reduce((s, f) => s + f.points, 0));
  for (const f of findings) {
    reasons.push(f.label);
    if (f.severity === 'hard') hardBlock = true;
  }
  if (!hardBlock && riskScore >= policy.riskBlockThreshold) {
    hardBlock = true;
    reasons.push(`Combined risk score ${riskScore} is at/over the block threshold of ${policy.riskBlockThreshold}`);
  }

  // Warn tier: no hard rule broken, but the risk score is high enough that a
  // human must decide before the agent may pay (track brief: the wrapper
  // "asks a human when it's warn").
  if (!hardBlock && riskScore >= (policy.reviewThreshold ?? 20)) {
    reasons.push(`Risk score ${riskScore} is in the human-review band (${policy.reviewThreshold ?? 20}–${policy.riskBlockThreshold - 1}) — held for a human decision`);
    return { verdict: VERDICT.REVIEW, riskScore, reasons, findings };
  }

  return {
    verdict: hardBlock ? VERDICT.BLOCKED : VERDICT.APPROVED,
    riskScore,
    reasons: reasons.length ? reasons : ['Within all limits and no risk patterns detected'],
    findings,
  };
}
