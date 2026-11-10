// Community blocklist reports.
//
// The policy ships with built-in blocked destinations; anyone (in the demo:
// any visitor; in production: other agents, via this API) can also REPORT a
// scam destination with evidence. Reports persist to a JSON file and merge
// into the effective blocklist used by every evaluation — the "shared
// blocklist that other agents can report to, with evidence attached" from
// the AI Security track brief.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isValidAccountId(s) {
  return typeof s === 'string' && s.length >= 2 && s.length <= 64 && ACCOUNT_RE.test(s);
}

export class BlocklistStore {
  constructor(filePath = null) {
    this.filePath = filePath;
    this.reports = [];
    if (filePath && existsSync(filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
        if (Array.isArray(parsed.reports)) this.reports = parsed.reports;
      } catch { /* corrupt file: start empty rather than crash the guard */ }
    }
  }

  add(destination, evidence) {
    const to = String(destination || '').toLowerCase().trim();
    if (!isValidAccountId(to)) throw new Error('destination is not a valid NEAR account id');
    const ev = String(evidence || '').trim().slice(0, 500);
    if (ev.length < 8) throw new Error('evidence is required (at least a short description of the scam)');
    const existing = this.reports.find((r) => r.destination === to);
    if (existing) return { report: existing, added: false };
    const report = { destination: to, evidence: ev, ts: new Date().toISOString() };
    this.reports.push(report);
    this.save();
    return { report, added: true };
  }

  destinations() {
    return this.reports.map((r) => r.destination);
  }

  save() {
    if (!this.filePath) return;
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify({ reports: this.reports }, null, 2));
  }
}
