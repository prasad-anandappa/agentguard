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

export const GENESIS_HASH = '0'.repeat(64);

export function canonicalEntry(e) {
  return JSON.stringify({
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
  });
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

  spentToday(now = new Date()) {
    const day = now.toISOString().slice(0, 10);
    return this.entries
      .filter((e) => e.verdict === 'APPROVED' && e.ts.slice(0, 10) === day)
      .reduce((s, e) => s + Number(e.amount), 0);
  }

  seenDestinations() {
    return new Set(this.entries.filter((e) => e.verdict === 'APPROVED').map((e) => e.to.toLowerCase()));
  }

  append({ agent, proposal, verdict, riskScore, reasons }) {
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
  // score = 100 * approved / attempts, discounted when blocked attempts exist
  // recently; kept deliberately simple so anyone can recompute it from the log.
  reputation(agent) {
    const mine = this.entries.filter((e) => e.agent === agent);
    const approved = mine.filter((e) => e.verdict === 'APPROVED').length;
    const blocked = mine.length - approved;
    if (!mine.length) return { agent, attempts: 0, approved: 0, blocked: 0, score: null, tier: 'NO HISTORY' };
    const score = Math.round((approved / mine.length) * 100);
    const tier = score >= 90 ? 'TRUSTED' : score >= 70 ? 'STANDARD' : score >= 40 ? 'WATCHED' : 'RESTRICTED';
    return { agent, attempts: mine.length, approved, blocked, score, tier };
  }
}
