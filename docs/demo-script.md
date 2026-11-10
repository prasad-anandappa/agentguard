# Demo script — AgentGuard (for Prasad to record, ~90 seconds)

Goal: one complete, judge-proof moment — agent proposes, guard decides, NEAR
proves it. Record the browser at http://localhost:8787 (start with
`npm start` from the repo folder; the header should show
"Decision log anchor: near-social · agentguard-nh.testnet").

## Shot list

1. **Hook (0:00–0:10)** — Show the page header. Say/post caption:
   "AI agents can move money now. This is the guard that decides whether a
   payment may happen — and proves the decision on NEAR."
2. **The rules (0:10–0:20)** — Point at the policy panel: per-transaction
   limit 100 NEAR, daily limit 250 NEAR. "The human sets the limits. The
   agent never touches money directly — it only proposes."
3. **In-policy payment (0:20–0:35)** — Click **"Pay a cloud bill — 12 NEAR"**.
   Show the green **APPROVED**, risk 0, and the new row appearing in the
   decision log with its NEAR anchor link.
4. **Over-limit payment (0:35–0:50)** — Click **"One big upfront payment —
   400 NEAR"**. Show **BLOCKED** and the reason: "exceeds the per-transaction
   limit of 100 NEAR" — even though the payee is the same trusted vendor.
5. **The scam (0:50–1:15)** — Click **"A prize release fee — 45 NEAR"**. Show
   **BLOCKED**, risk 100, reasons: blocklisted destination, prize-claim lure,
   urgency pressure. "The agent was manipulated by the memo — the guard was
   not."
6. **The proof (1:15–1:30)** — Click the anchor link on the scam row. The
   NEAR testnet explorer opens showing the real transaction with the
   decision hash and BLOCKED verdict. "Every verdict — approve or block — is
   anchored to NEAR testnet. Anyone can audit what the agent tried to do."
   Optional terminal beat: run `node scripts/anchor-check.mjs` and show
   "ALL ANCHORED ENTRIES VERIFIED ON-CHAIN ✓".

## If screenshots instead of video

Capture: (1) the APPROVED result card, (2) the BLOCKED over-limit result
card, (3) the BLOCKED scam result card with the log table visible, (4) the
explorer page for the scam transaction. Attach all four to the X post.
