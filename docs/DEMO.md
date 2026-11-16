# 3-Minute Interactive Demo Script

This walkthrough guides you through demonstrating the durable workflow engine, including human-in-the-loop approval gates, shadow forking (what-if branching without external side effects), side-by-side diffing, and worker crash recovery.

---

## Prerequisites (10 seconds)

Ensure PostgreSQL is running locally and migrations are applied:
```bash
# Terminal 1: Apply database migrations
pnpm --filter @durable/engine migrate
```

---

## Step 1: Start the Web Inspector Dashboard (20 seconds)

Start the API and UI development servers:
```bash
# Terminal 1: Start API server on 127.0.0.1:3000
pnpm --filter @durable/api dev

# Terminal 2: Start Vite Inspector UI on localhost:5173
pnpm --filter @durable/ui dev
```
Open your browser to: **http://localhost:5173**

---

## Step 2: Run the Live Demo Walkthrough (60 seconds)

In a third terminal, run the automated demo script:
```bash
# Terminal 3: Run the end-to-end invoice walkthrough
pnpm demo
```

### What is happening behind the scenes:
1. **Mock External Services**: Local HTTP servers start on ephemeral loopback ports:
   - **Risk Assessment API**: evaluates transaction risk and flags transactions > $1,000 as high risk.
   - **Payment Gateway API**: simulates Stripe/payment processor with idempotency keys.
   - **Customer Webhook Notification**: dispatches order confirmation webhooks.
2. **Structured LLM Extraction**: An invoice for **$1,250.00** from *Acme Cloud Infrastructure* is parsed.
3. **Risk Check**: The Risk Assessment API flags the $1,250 transaction as **high risk (score 88)**, requiring manager sign-off.
4. **Approval Gate Parking**:
   - The workflow reaches `ctx.waitForApproval("invoice-manager-approval", ...)`.
   - The run state transitions to `running` (parked).
   - **Crucial Invariant**: While parked, the worker holds **0 leases** and the task queue contains **0 pending tasks**.

---

## Step 3: Inspect the Parked Run in the Web UI (30 seconds)

1. Refresh **http://localhost:5173**.
2. Click on the active parked run (e.g., `demo_invoice_...`).
3. Observe:
   - **Run Header**: Mode is `LIVE`, status is `RUNNING`.
   - **Pending Approval Banner**: Displays a warning card:
     > *"Pending Approval: invoice-manager-approval"*
     > Shows invoice details: Vendor Acme Cloud, Amount $1,250.00, Risk Score 88.
     > Contains **Approve** and **Reject** buttons.
   - **Event Timeline**: Displays `RunStarted`, `StepCompleted (extract-invoice)`, `StepCompleted (risk-assessment)`, and `ApprovalRequested`.
   - **External Effects**: Notice that **0 external charges** have been processed yet.

---

## Step 4: Test a "What-If" Shadow Fork (40 seconds)

Before approving the $1,250 expense, the finance team wants to ask:
> *"What if we applied an enterprise discount code (VIP50) to reduce the cost below $1,000?"*

1. Click **Fork Run** in the web UI header (or review the script's shadow fork output).
2. Set target step to `extract-invoice` and specify edited input with `discount: "VIP50"`.
3. The engine creates a **Shadow Fork**:
   - Copies previous history up to the fork point.
   - Executes forward in **Shadow Mode**.
   - `extract-invoice` computes the new discounted total: **$625.00**.
   - Because $625 is under $1,000 and risk is low, the workflow logic bypasses the approval gate requirement.
   - `payment-charge` executes in shadow mode: intercepted by `ShadowHttpConnector`! **Zero outbound HTTP requests are made.**
   - `customer-notification` executes in shadow mode: intercepted! **Zero customer emails sent.**
   - `record-ledger` executes in shadow mode: executed inside an isolated transaction that **automatically rolls back**.
4. In the UI, view the **Diff View**:
   - Displays side-by-side comparison between the live parent run and shadow fork.
   - Highlights the edited amount ($1,250.00 vs $625.00).
   - Shows captured external effects with badge `[CAPTURED - SHADOW]`.

---

## Step 5: Approve the Original Live Run (20 seconds)

1. Return to the original parent run in the UI.
2. Click **Approve** in the Pending Approval banner.
3. The engine records `ApprovalGranted`, schedules a continuation task, and the worker resumes:
   - Steps 1 & 2 replay deterministically from the immutable event log (not re-executed).
   - Step 3 reads the approval decision.
   - Step 4 executes live: **real charge processed in Payment Gateway**.
   - Step 5 executes live: **real notification delivered to customer**.
   - Step 6 executes live: **audit record committed to PostgreSQL ledger table**.
   - Run finishes with status `COMPLETED`.

---

## Step 6: Multi-Process Worker Chaos Demonstration (20 seconds)

To demonstrate fault tolerance, at-least-once external network attempts with idempotency keys, and exactly-once event log recording under catastrophic failure:
```bash
# Terminal 3: Run multi-process worker chaos suite
pnpm chaos
```
### What this verifies:
- Spawns **3 separate OS worker processes** via `child_process.fork`.
- Runs 10 concurrent workflows with slow steps.
- Kills worker processes via uncatchable **SIGKILL** (Win32 `TerminateProcess`, simulating crash/OOM).
- Replaces killed workers dynamically while remaining workers claim expired leases.
- In count-only mode (no receiver dedup), proves external calls are at-least-once: duplicate network attempts carry the exact same idempotency key, while each step completion is recorded exactly once in the event log.
- Asserts across all 10 workflows:
  - 100% completion (`completed`).
  - **0 duplicate StepCompleted events** in the event log.
  - Strictly contiguous sequence numbers (`1..N`).
  - Outbound retries carry matching `Idempotency-Key` headers.
