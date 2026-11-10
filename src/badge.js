// Verdict badges: a shields-style SVG anyone can embed (README, docs, a
// dashboard) as portable proof of one AgentGuard decision. The badge is a
// rendering of the ledger entry — the entry hash in the URL is the proof;
// the full verification path is `npm run verify` / the /verify page.

export const VERDICT_COLORS = { APPROVED: '#2fbf71', BLOCKED: '#ef4b4b', REVIEW: '#f2b13c' };

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Rough text width at 11px Verdana-ish (shields.io uses ~6.5px/char + padding).
const textW = (s) => Math.round(String(s).length * 6.5) + 10;

export function badgeSvg(entry) {
  if (!entry) {
    const left = 'agentguard';
    const right = 'decision not found';
    const lw = textW(left), rw = textW(right), w = lw + rw;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="agentguard: decision not found"><rect width="${w}" height="20" rx="3" fill="#555"/><rect x="${lw}" width="${rw}" height="20" rx="3" fill="#9f9f9f"/><text x="${lw / 2}" y="14" fill="#fff" font-family="Verdana,sans-serif" font-size="11" text-anchor="middle">${left}</text><text x="${lw + rw / 2}" y="14" fill="#fff" font-family="Verdana,sans-serif" font-size="11" text-anchor="middle">${right}</text></svg>`;
  }
  const left = `agentguard #${entry.seq}`;
  const right = `${entry.verdict} · risk ${entry.riskScore}`;
  const color = VERDICT_COLORS[entry.verdict] || '#555';
  const lw = textW(left), rw = textW(right), w = lw + rw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(left)}: ${esc(right)}"><rect width="${w}" height="20" rx="3" fill="#0b0f14"/><rect x="${lw}" width="${rw}" height="20" rx="3" fill="${color}"/><text x="${lw / 2}" y="14" fill="#fff" font-family="Verdana,sans-serif" font-size="11" text-anchor="middle">${esc(left)}</text><text x="${lw + rw / 2}" y="14" fill="#fff" font-family="Verdana,sans-serif" font-size="11" text-anchor="middle">${esc(right)}</text></svg>`;
}
