// AgentGuard decision ledger.
//
// Append-only, hash-chained log of every agent payment proposal and the
// guard's verdict. Each entry commits to the previous entry's hash, so any
// later edit breaks the chain and is detectable. Entry hashes are anchored to
// NEAR testnet (see anchor.js), which makes the log auditable by anyone:
// recompute the chain locally, compare the hashes against the on-chain ones.

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { categoryOf } from './policy.js';

export const GENESIS_HASH = '0'.repeat(64);

export function canonicalEntry(e) {
  const base = {
    seq: e.seq,
    ts: e.ts,
    agent: e.agent,
    to: e.to,
    amount: e.amount,
    memo: e.memo,
    verdict: e.verdict,
    riskScore: e.riskScore,
    reasons: e.reasons,
    prevHash: e.prevHash,
  };
  // Resolution entries (a human deciding a held REVIEW entry) commit to the
  // entry they resolve. Fields are included only when present so entries
  // written before resolutions existed hash exactly as before.
  if (e.kind) base.kind = e.kind;
  if (e.refSeq) base.refSeq = e.refSeq;
  return JSON.stringify(base);
}

export function hashEntry(e) {
  return createHash('sha256').update(canonicalEntry(e)).digest('hex');
}

export class Ledger {
  constructor(filePath = null) {
    this.filePath = filePath;
    this.entries = [];
    if (filePath) {
      mkdirSync(path.dirname(filePath), { recursive: true });
      if (existsSync(filePath)) {
        for (const line of readFileSync(filePath, 'utf8').split('\n')) {
          if (line.trim()) this.entries.push(JSON.parse(line));
        }
      }
    }
  }

  get lastHash() {
    return this.entries.length ? this.entries[this.entries.length - 1].hash : GENESIS_HASH;
  }

  // Final outcome per entry seq: a held (REVIEW) decision counts as its
  // human resolution once one exists. Resolution entries map to themselves.
  finalVerdicts() {
    const resolutions = new Map(
      this.entries.filter((e) => e.kind === 'resolution').map((e) => [e.refSeq, e.verdict]),
    );
    const out = new Map();
    for (const e of this.entries) out.set(e.seq, resolutions.get(e.seq) || e.verdict);
    return out;
  }

  spentToday(now = new Date(), agent = null) {
    const day = now.toISOString().slice(0, 10);
    return this.entries
      .filter((e) => e.verdict === 'APPROVED' && e.ts.slice(0, 10) === day && (!agent || e.agent === agent))
      .reduce((s, e) => s + Number(e.amount), 0);
  }

  seenDestinations(agent = null) {
    return new Set(this.entries
      .filter((e) => e.verdict === 'APPROVED' && (!agent || e.agent === agent))
      .map((e) => e.to.toLowerCase()));
  }

  // Raw recent attempts for the velocity check: non-resolution entries from
  // the last maxAgeMs, with their final verdicts, oldest first.
  recentPayments(agent = null, maxAgeMs = 24 * 3600_000, now = Date.now()) {
    const finals = this.finalVerdicts();
    return this.entries
      .filter((e) => e.kind !== 'resolution' && (!agent || e.agent === agent))
      .map((e) => ({ to: e.to.toLowerCase(), amount: Number(e.amount), ts: Date.parse(e.ts), verdict: finals.get(e.seq) || e.verdict }))
      .filter((p) => Number.isFinite(p.ts) && now - p.ts <= maxAgeMs);
  }

  // Month-to-date approved spend per memo category (final outcomes).
  categorySpendThisMonth(agent = null, now = new Date()) {
    const month = now.toISOString().slice(0, 7);
    const finals = this.finalVerdicts();
    const out = { hosting: 0, dev: 0, tools: 0, other: 0 };
    for (const e of this.entries) {
      if (e.kind === 'resolution') continue;
      if (agent && e.agent !== agent) continue;
      if (!e.ts.startsWith(month)) continue;
      if (finals.get(e.seq) !== 'APPROVED') continue;
      out[categoryOf(e.memo)] += Number(e.amount);
    }
    return out;
  }

  // Headline numbers for the demo's live stats strip — all computed from the
  // ledger, nothing hard-coded. "Attacks stopped" and "NEAR protected" use
  // final outcomes: a held payment a human then denied counts once, as the
  // original attempt.
  stats() {
    const finals = this.finalVerdicts();
    const attempts = this.entries.filter((e) => e.kind !== 'resolution');
    const blocked = attempts.filter((e) => finals.get(e.seq) === 'BLOCKED');
    return {
      decisions: attempts.length,
      totalEntries: this.entries.length,
      approved: attempts.filter((e) => finals.get(e.seq) === 'APPROVED').length,
      attacksStopped: blocked.length,
      nearProtected: Math.round(blocked.reduce((s, e) => s + Number(e.amount), 0) * 100) / 100,
      heldPending: this.pendingReview().length,
      anchored: this.entries.filter((e) => e.anchor?.anchored).length,
      chainValid: this.verifyChain().ok,
    };
  }

  // Counterparty trust: consecutive clean (finally APPROVED) payments per
  // destination. A final BLOCK resets the streak; an unresolved REVIEW
  // neither builds nor breaks it. At `threshold` consecutive approvals the
  // counterparty graduates to trusted.
  counterpartyTrust(threshold = 3) {
    const finals = this.finalVerdicts();
    const byDest = new Map();
    for (const e of this.entries) {
      if (e.kind === 'resolution') continue;
      const key = e.to.toLowerCase();
      if (!byDest.has(key)) byDest.set(key, { destination: key, cleanStreak: 0, totalApproved: 0, totalBlocked: 0 });
      const rec = byDest.get(key);
      const v = finals.get(e.seq);
      if (v === 'APPROVED') { rec.cleanStreak += 1; rec.totalApproved += 1; } else if (v === 'BLOCKED') { rec.cleanStreak = 0; rec.totalBlocked += 1; }
    }
    const out = {};
    for (const [key, rec] of byDest) {
      out[key] = {
        ...rec,
        threshold,
        trusted: rec.cleanStreak >= threshold,
        progress: `${Math.min(rec.cleanStreak, threshold)}/${threshold}`,
      };
    }
    return out;
  }

  trustedDestinations(threshold = 3) {
    const trust = this.counterpartyTrust(threshold);
    return new Set(Object.values(trust).filter((t) => t.trusted).map((t) => t.destination));
  }

  append({ agent, proposal, verdict, riskScore, reasons, kind = null, refSeq = null }) {
    const entry = {
      seq: this.entries.length + 1,
      ts: new Date().toISOString(),
      agent: agent || 'agent',
      to: proposal.to,
      amount: Number(proposal.amount),
      memo: proposal.memo || '',
      verdict,
      riskScore,
      reasons,
      prevHash: this.lastHash,
    };
    if (kind) entry.kind = kind;
    if (refSeq) entry.refSeq = refSeq;
    entry.hash = hashEntry(entry);
    entry.anchor = null; // filled in by the anchor step: { txHash, explorerUrl, ... }
    this.entries.push(entry);
    if (this.filePath) appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
    return entry;
  }

  setAnchor(seq, anchor) {
    const entry = this.entries.find((e) => e.seq === seq);
    if (entry) {
      entry.anchor = anchor;
      // The anchor is not part of the hashed content, so updating it does not
      // affect the chain — but it must be persisted, or a reload loses it.
      if (this.filePath) {
        writeFileSync(this.filePath, this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
      }
    }
    return entry;
  }

  // Persist every entry (used after import / bulk metadata updates).
  saveAll() {
    if (this.filePath) {
      writeFileSync(this.filePath, this.entries.map((e) => JSON.stringify(e)).join('\n') + (this.entries.length ? '\n' : ''));
    }
  }

  // Build a ledger from exported entries, validating the hash chain.
  // Returns { ledger, chain } — callers must check chain.ok before trusting.
  static fromEntries(entries, filePath = null) {
    const ledger = new Ledger(null);
    ledger.entries = Array.isArray(entries) ? entries.map((e) => ({ ...e })) : [];
    const chain = ledger.verifyChain();
    if (chain.ok && filePath) {
      ledger.filePath = filePath;
      mkdirSync(path.dirname(filePath), { recursive: true });
      ledger.saveAll();
    }
    return { ledger, chain };
  }

  // The verdict rule trace is presentation metadata, not hashed content.
  setTrace(seq, trace) {
    const entry = this.entries.find((e) => e.seq === seq);
    if (entry) {
      entry.trace = trace;
      if (this.filePath) this.saveAll();
    }
    return entry;
  }

  // Counterparty screening info (on-chain facts about the destination) is
  // metadata about the decision, not part of the hashed entry.
  setCounterparty(seq, counterparty) {
    const entry = this.entries.find((e) => e.seq === seq);
    if (entry) {
      entry.counterparty = counterparty;
      if (this.filePath) {
        writeFileSync(this.filePath, this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
      }
    }
    return entry;
  }

  // Reconstruct the evaluation context as it stood just BEFORE the given
  // entry: what the guard had seen, spent and trusted at that moment. Used
  // by decision replay so a policy change is the only variable that moves.
  // (Beneficiary caps are current-state and not reconstructed.)
  contextBefore(entry, threshold = 3) {
    const tmp = new Ledger(null);
    tmp.entries = this.entries.filter((e) => e.seq < entry.seq);
    const ts = Date.parse(entry.ts);
    return {
      now: ts,
      spentToday: tmp.spentToday(new Date(ts), entry.agent),
      seenDestinations: tmp.seenDestinations(entry.agent),
      trustedDestinations: tmp.trustedDestinations(threshold),
      recentPayments: tmp.recentPayments(entry.agent, 24 * 3600_000, ts),
      spentThisMonthByCategory: tmp.categorySpendThisMonth(entry.agent, new Date(ts)),
      beneficiaryCap: null,
    };
  }

  // REVIEW entries a human has not decided yet (no resolution entry exists).
  pendingReview() {
    const resolved = new Set(this.entries.filter((e) => e.kind === 'resolution').map((e) => e.refSeq));
    return this.entries.filter((e) => e.verdict === 'REVIEW' && !resolved.has(e.seq));
  }

  verifyChain() {
    let prev = GENESIS_HASH;
    for (const e of this.entries) {
      if (e.prevHash !== prev) return { ok: false, atSeq: e.seq, why: 'prevHash mismatch' };
      if (hashEntry(e) !== e.hash) return { ok: false, atSeq: e.seq, why: 'hash mismatch — entry was altered' };
      prev = e.hash;
    }
    return { ok: true, entries: this.entries.length };
  }

  // Per-agent reputation from the anchored history: transparent and earned.
  // Counts guard decisions by their FINAL outcome — a held (REVIEW) decision
  // counts as its human resolution once one exists; resolution entries
  // themselves are not new attempts. score = 100 * approved / resolved,
  // kept deliberately simple so anyone can recompute it from the log.
  reputation(agent) {
    const resolutions = new Map(
      this.entries.filter((e) => e.kind === 'resolution').map((e) => [e.refSeq, e.verdict]),
    );
    const mine = this.entries.filter((e) => e.agent === agent && e.kind !== 'resolution');
    const finalVerdict = (e) => resolutions.get(e.seq) || e.verdict;
    const approved = mine.filter((e) => finalVerdict(e) === 'APPROVED').length;
    const blocked = mine.filter((e) => finalVerdict(e) === 'BLOCKED').length;
    const held = mine.filter((e) => finalVerdict(e) === 'REVIEW').length;
    if (!mine.length) return { agent, attempts: 0, approved: 0, blocked: 0, held: 0, score: null, tier: 'NO HISTORY' };
    const resolved = approved + blocked;
    const score = resolved ? Math.round((approved / resolved) * 100) : null;
    const tier = score === null ? 'UNRATED' : score >= 90 ? 'TRUSTED' : score >= 70 ? 'STANDARD' : score >= 40 ? 'WATCHED' : 'RESTRICTED';
    return { agent, attempts: mine.length, approved, blocked, held, score, tier };
  }
}
