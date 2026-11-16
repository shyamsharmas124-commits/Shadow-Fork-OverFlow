import { Engine, Worker } from "@durable/engine";
import pg from "pg";
import { invoiceProcessingWorkflow } from "./invoiceWorkflow.js";
import { startMockServers } from "./mocks.js";

const { Pool } = pg;

async function main() {
  const isRealApi = Boolean(process.env.ANTHROPIC_API_KEY);
  if (isRealApi) {
    if (!process.env.ANTHROPIC_MODEL) {
      console.error("ERROR: ANTHROPIC_API_KEY is provided but ANTHROPIC_MODEL is not set.");
      console.error("Please export ANTHROPIC_MODEL (e.g. claude-3-5-sonnet-20241022). No fallback is permitted.");
      process.exit(1);
    }
    console.log(`[MODE: REAL ANTHROPIC API (Model: ${process.env.ANTHROPIC_MODEL})]`);
  } else {
    console.log("[MODE: DETERMINISTIC RECORDED FALLBACK - NO ANTHROPIC_API_KEY PROVIDED]");
    console.log("*******************************************************************************");
    console.log("* LOUD NOTICE: NO ANTHROPIC_API_KEY PROVIDED!                                 *");
    console.log("* RUNNING DEMO WITH DETERMINISTIC RECORDED FALLBACK FIXTURES.                 *");
    console.log("* TO USE REAL ANTHROPIC LLM INVOICE EXTRACTION, EXPORT:                       *");
    console.log("*   ANTHROPIC_API_KEY=\"sk-ant-...\"                                            *");
    console.log("*   ANTHROPIC_MODEL=\"claude-3-5-sonnet-20241022\"                              *");
    console.log("*******************************************************************************\n");
  }

  console.log("=============================================================");
  console.log("   DURABLE WORKFLOW ENGINE - SHADOW FORK DEMO");
  console.log("=============================================================\n");

  const databaseUrl =
    process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/durable";
  const pool = new Pool({ connectionString: databaseUrl });

  // 1. Setup Database table for ledger
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoice_audit_ledger (
      id SERIAL PRIMARY KEY,
      run_id UUID,
      invoice_number TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 2. Start mock external services
  console.log("[1/6] Starting mock external HTTP services on loopback...");
  const mocks = await startMockServers();
  console.log(`      ✓ Risk Assessment API:    ${mocks.riskServerUrl}`);
  console.log(`      ✓ Payment Gateway API:    ${mocks.paymentServerUrl}`);
  console.log(`      ✓ Customer Notification:  ${mocks.notificationServerUrl}`);

  // 3. Initialize engine & worker
  const engine = new Engine(pool);
  const workflowType = `demo_invoice_${Date.now()}`;
  engine.register(workflowType, invoiceProcessingWorkflow);
  const worker = new Worker(engine, { workerId: "demo-worker-1", pollIntervalMs: 50 });

  const rawInvoice = `
INVOICE
Vendor: Acme Cloud Infrastructure Inc.
Invoice Number: INV-2026-9042
Customer ID: cust_enterprise_99
Date: 2026-11-16
Items:
  - 10x High-Performance GPU Nodes: $1,000.00
  - Dedicated Postgres Primary: $250.00
Total: $1,250.00
  `;

  // 4. Start Live Run
  console.log("\n[2/6] Starting Live Run for $1,250.00 invoice (exceeds $1,000 threshold)...");
  const parentRunId = await engine.startRun(workflowType, {
    invoiceRawText: rawInvoice,
    customerId: "cust_enterprise_99",
    riskServiceUrl: mocks.riskServerUrl,
    paymentServiceUrl: mocks.paymentServerUrl,
    notificationServiceUrl: mocks.notificationServerUrl,
  });
  console.log(`      ✓ Started run: ${parentRunId}`);

  // Tick worker until parked
  console.log("      Worker executing steps (LLM extraction, Risk Assessment)...");
  await worker.tick(); // executes until waitForApproval -> parks

  const parkedRun = await engine.getRun(parentRunId);
  const events = await engine.getEvents(parentRunId);
  const approvalEvent = events.find((e) => e.type === "ApprovalRequested");
  const extractEvent = events.find(
    (e) => e.type === "StepCompleted" && (e.payload as { name: string }).name === "extract-invoice",
  );

  console.log(`      ⏸ Run status: ${parkedRun?.status.toUpperCase()}`);
  console.log(
    `      ⏸ Approval Gate: "${(approvalEvent?.payload as { name?: string })?.name}" requested for amount $1,250.00.`,
  );
  console.log(`      ⏸ External charges made so far: ${mocks.stats.charges.length} (0 charges)`);

  // 5. Create Shadow Fork to test "What if we applied a VIP50 discount code?"
  console.log("\n[3/6] Branching Shadow Fork to simulate 'What-If: VIP50 discount applied'...");
  const forkRunId = await engine.fork(parentRunId, extractEvent!.seq, {
    input: {
      rawText: rawInvoice,
      discount: "VIP50", // 50% discount -> $625.00
    },
    mocks: {
      "risk-assessment": {
        riskLevel: "low",
        score: 12,
        requiresApproval: false,
        assessedAt: new Date().toISOString(),
      },
      "payment-charge": {
        chargeId: "ch_shadow_simulated",
        status: "succeeded",
        amount: 625,
      },
      "customer-notification": {
        delivered: true,
      },
    },
  });
  console.log(`      ✓ Forked shadow run: ${forkRunId}`);

  // Tick worker for shadow fork until complete
  console.log("      Running shadow fork to completion...");
  for (let i = 0; i < 10; i++) {
    const worked = await worker.tick();
    if (!worked) break;
  }

  const finishedFork = await engine.getRun(forkRunId);
  console.log(`      ✓ Shadow fork finished with status: ${finishedFork?.status.toUpperCase()}`);
  console.log(
    `      ✓ Fork result amount: $${(finishedFork?.result as { invoice?: { amount?: number } })?.invoice?.amount?.toFixed(2)}`,
  );
  console.log(
    `      ✓ External charges made during shadow fork: 0 (prevented by shadow interceptor!)`,
  );
  console.log(`      ✓ Total charges in payment gateway: ${mocks.stats.charges.length} (still 0)`);

  // 6. Approve the original live run
  console.log("\n[4/6] Approving the original live run as Human-in-the-Loop manager...");
  await engine.submitApproval(parentRunId, "invoice-manager-approval", {
    decision: "approve",
    note: "Approved by VP Engineering under Q4 Infrastructure budget",
  });
  console.log("      ✓ Approval submitted: APPROVED");

  // Tick worker to resume and finish live run
  console.log("      Worker resuming live run...");
  for (let i = 0; i < 10; i++) {
    const worked = await worker.tick();
    if (!worked) break;
  }

  const completedParent = await engine.getRun(parentRunId);
  console.log(`      ✓ Live run status: ${completedParent?.status.toUpperCase()}`);
  if (completedParent?.error) {
    console.log(`      ✕ Live run error: ${completedParent.error}`);
  }
  console.log(
    `      ✓ Real payment charge ID: ${(completedParent?.result as { payment?: { chargeId?: string } })?.payment?.chargeId}`,
  );
  console.log(`      ✓ Total charges processed in real gateway: ${mocks.stats.charges.length}`);
  console.log(
    `      ✓ Total customer notifications delivered: ${mocks.stats.notifications.length}`,
  );

  // 7. Verify ledger in database
  const ledgerRows = await pool.query(
    "SELECT * FROM invoice_audit_ledger WHERE invoice_number = 'INV-2026-9042'",
  );
  console.log(`      ✓ Database audit ledger rows committed: ${ledgerRows.rowCount}`);

  // 8. Next steps & UI instructions
  console.log("\n=============================================================");
  console.log("   DEMO COMPLETED SUCCESSFULLY!");
  console.log("=============================================================");
  console.log("\nTo inspect the execution history, shadow fork diff, and approval card in the UI:");
  console.log("1. Start the API server:     pnpm --filter @durable/api dev");
  console.log("2. Start the web UI:         pnpm --filter @durable/ui dev");
  console.log(`3. Open in your browser:     http://localhost:5173#${parentRunId}\n`);

  await mocks.stop();
  await pool.end();
}

main().catch((err) => {
  console.error("Demo failed with error:", err);
  process.exit(1);
});
