// Beneficiary book: saved counterparties with a human note and an optional
// per-beneficiary payment cap. A cap overrides the global per-transaction
// limit whenever it is stricter — it can only tighten, never loosen.
// File-backed like the shared blocklist; a null path gives an in-memory book.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { isValidAccountId } from './blocklist.js';

export class BeneficiaryStore {
  constructor(filePath = null) {
    this.filePath = filePath;
    this.items = new Map(); // account -> { account, note, capNear, addedAt }
    if (filePath) {
      mkdirSync(path.dirname(filePath), { recursive: true });
      if (existsSync(filePath)) {
        for (const item of JSON.parse(readFileSync(filePath, 'utf8'))) {
          this.items.set(item.account, item);
        }
      }
    }
  }

  save() {
    if (this.filePath) writeFileSync(this.filePath, JSON.stringify([...this.items.values()], null, 2) + '\n');
  }

  add(account, { note = '', capNear = null } = {}) {
    const acct = String(account || '').toLowerCase().trim();
    if (!isValidAccountId(acct)) throw new Error(`"${account}" is not a valid NEAR account id`);
    const cap = capNear === null || capNear === undefined || capNear === '' ? null : Number(capNear);
    if (cap !== null && (!Number.isFinite(cap) || cap <= 0)) throw new Error('capNear must be a positive number of NEAR, or empty for no cap');
    const item = { account: acct, note: String(note || '').slice(0, 200), capNear: cap, addedAt: new Date().toISOString() };
    const existed = this.items.has(acct);
    this.items.set(acct, item);
    this.save();
    return { item, updated: existed };
  }

  remove(account) {
    const acct = String(account || '').toLowerCase().trim();
    const had = this.items.delete(acct);
    if (had) this.save();
    return had;
  }

  get(account) {
    return this.items.get(String(account || '').toLowerCase().trim()) || null;
  }

  capFor(account) {
    const item = this.get(account);
    return item && Number.isFinite(item.capNear) ? item.capNear : null;
  }

  list() {
    return [...this.items.values()];
  }
}
