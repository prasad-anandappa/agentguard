# Demo script — AgentGuard (for Prasad to record, ~90 seconds)

Goal: one complete, judge-proof moment — agent proposes, guard decides, NEAR
proves it. Record the browser at https://agentguard.nammaprojects.com
(or http://localhost:8787 after `npm start` from the repo folder; the header
should show "Decision log anchor: dedicated-contract ·
agentguard-nh.testnet").

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
5. **The scam (0:50–1:10)** — Click **"A prize release fee — 45 NEAR"**. Show
   **BLOCKED**, risk 100, reasons: blocklisted destination, prize-claim lure,
   urgency pressure. "The agent was manipulated by the memo — the guard was
   not."
6. **The grey zone (1:10–1:20)** — Click **"First payment to a brand-new
   vendor — 30 NEAR"**. Show the amber **HELD FOR HUMAN REVIEW** card, then
   click **✓ Approve & log my decision**. "Not clean, not clearly a scam —
   so a human decides, and that decision is logged too."
7. **The proof (1:20–1:35)** — Click the anchor link on any row. The NEAR
   testnet explorer opens showing the real transaction into the project's
   own log contract (`log.agentguard-nh.testnet`) with the decision hash and
   verdict. "Every verdict — approve, block, or held — is anchored to NEAR
   testnet by a function-call key that can do nothing else. Anyone can
   audit what the agent tried to do."
   Optional terminal beat: run `npm run anchor-check` and show
   "ALL ANCHORED ENTRIES VERIFIED ON-CHAIN ✓".

## If screenshots instead of video

Capture: (1) the APPROVED result card, (2) the BLOCKED over-limit result
card, (3) the BLOCKED scam result card with the log table visible, (4) the
explorer page for the scam transaction. Attach all four to the X post.
