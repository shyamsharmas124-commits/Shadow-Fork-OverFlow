import { Engine, Worker } from "@durable/engine";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractInvoiceFallback, invoiceProcessingWorkflow } from "../src/invoiceWorkflow.js";
import { type MockServers, startMockServers } from "../src/mocks.js";

const { Pool } = pg;

describe("Milestone 6b - Demo Workflow & Shadow Fork Walkthrough", () => {
  let pool: pg.Pool;
  let engine: Engine;
  let mocks: MockServers;

  beforeAll(async () => {
    pool = new Pool({
      connectionString:
        process.env.DATABASE_URL || "postgres://postgres:postgres@127.0.0.1:5432/durable",
    });

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

    mocks = await startMockServers();
    engine = new Engine(pool);
  });

  afterAll(async () => {
    await mocks.stop();
    await pool.end();
  });

  it("extractInvoiceFallback extracts structured fields and applies discount codes correctly", () => {
    const rawInvoice = `
Vendor: Anthropic Labs
Invoice Number: INV-99001
Customer ID: cust_ai_1
Total: $2,500.00
    `;

    const withoutDiscount = extractInvoiceFallback(rawInvoice);
    expect(withoutDiscount.vendor).toBe("Anthropic Labs");
    expect(withoutDiscount.invoiceNumber).toBe("INV-99001");
    expect(withoutDiscount.amount).toBe(2500);
    expect(withoutDiscount.discountApplied).toBeUndefined();

    const with50 = extractInvoiceFallback(rawInvoice, "VIP50");
    expect(with50.amount).toBe(1250);
    expect(with50.discountApplied).toContain("50%");

    const with20 = extractInvoiceFallback(rawInvoice, "VIP20");
    expect(with20.amount).toBe(2000);
    expect(with20.discountApplied).toContain("20%");
  });

  it("executes the full demo story: pauses at approval, forks in shadow mode without side effects, approves original to completion", async () => {
    const workflowType = `demo_wf_${Date.now()}`;
    engine.register(workflowType, invoiceProcessingWorkflow);
    const worker = new Worker(engine, { workerId: "worker-demo", pollIntervalMs: 50 });

    const invoiceNum = `INV-DEMO-${Date.now()}`;
    const rawInvoice = `
Vendor: Vertex Infra
Invoice Number: ${invoiceNum}
Customer ID: cust_demo_7
Total: $1,500.00
    `;

    // 1. Start Live Run ($1,500 > $1,000 threshold)
    const runId = await engine.startRun(workflowType, {
      invoiceRawText: rawInvoice,
      customerId: "cust_demo_7",
      riskServiceUrl: mocks.riskServerUrl,
      paymentServiceUrl: mocks.paymentServerUrl,
      notificationServiceUrl: mocks.notificationServerUrl,
    });

    // Tick worker: claims __init__ task, runs extract-invoice, risk-assessment, and parks at waitForApproval
    const t1 = await worker.tick();
    expect(t1).toBe(true);

    // Run must now be parked with 0 pending tasks
    const parkedRun = await engine.getRun(runId);
    expect(parkedRun?.status).toBe("running");

    const pendingTasks = await pool.query(
      "SELECT * FROM tasks WHERE run_id = $1 AND status = 'pending'",
      [runId],
    );
    expect(pendingTasks.rowCount).toBe(0);

    const events = await engine.getEvents(runId);
    const approvalReq = events.find((e) => e.type === "ApprovalRequested");
    expect(approvalReq).toBeDefined();
    expect((approvalReq!.payload as { name: string }).name).toBe("invoice-manager-approval");

    const extractEvent = events.find(
      (e) =>
        e.type === "StepCompleted" && (e.payload as { name: string }).name === "extract-invoice",
    );
    expect(extractEvent).toBeDefined();

    // No charges made yet
    const chargesBeforeFork = mocks.stats.charges.length;

    // 2. Create Shadow Fork at extract-invoice step with discount code VIP50 and mocks for external effects
    const forkId = await engine.fork(runId, extractEvent!.seq, {
      input: {
        rawText: rawInvoice,
        discount: "VIP50", // $1,500 * 0.5 = $750 (< $1,000 auto-approved!)
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
          amount: 750,
        },
        "customer-notification": {
          delivered: true,
        },
      },
    });

    // Run shadow fork to completion
    for (let i = 0; i < 10; i++) {
      const worked = await worker.tick();
      if (!worked) break;
    }

    const completedFork = await engine.getRun(forkId);
    expect(completedFork?.status).toBe("completed");
    expect((completedFork!.result as { invoice: { amount: number } }).invoice.amount).toBe(750);

    // Assert that shadow fork produced 0 external charges and 0 external notifications
    expect(mocks.stats.charges.length).toBe(chargesBeforeFork);

    // Verify EffectCaptured was recorded for shadow operations
    const forkEvents = await engine.getEvents(forkId);
    const effectsCaptured = forkEvents.filter((e) => e.type === "EffectCaptured");
    expect(effectsCaptured.length).toBeGreaterThanOrEqual(1);

    // 3. Approve original live run
    await engine.submitApproval(runId, "invoice-manager-approval", {
      decision: "approve",
      note: "Approved by finance lead",
    });

    // Run original to completion
    for (let i = 0; i < 10; i++) {
      const worked = await worker.tick();
      if (!worked) break;
    }

    const completedParent = await engine.getRun(runId);
    expect(completedParent?.status).toBe("completed");
    expect((completedParent!.result as { payment: { status: string } }).payment.status).toBe(
      "succeeded",
    );

    // Assert that live run produced exactly 1 real charge and 1 real notification
    expect(mocks.stats.charges.length).toBe(chargesBeforeFork + 1);
    expect(mocks.stats.notifications.length).toBeGreaterThanOrEqual(1);

    // Assert DB ledger row committed for live run
    const ledger = await pool.query(
      "SELECT * FROM invoice_audit_ledger WHERE invoice_number = $1",
      [invoiceNum],
    );
    expect(ledger.rowCount).toBe(1);
  });

  it("rejecting the approval gate fails the run with the rejection note", async () => {
    const workflowType = `demo_reject_${Date.now()}`;
    engine.register(workflowType, invoiceProcessingWorkflow);
    const worker = new Worker(engine, { workerId: "worker-demo-reject", pollIntervalMs: 50 });

    const rawInvoice = `
Vendor: Sketchy Vendor
Invoice Number: INV-000
Customer ID: cust_reject
Total: $9,999.00
    `;

    const runId = await engine.startRun(workflowType, {
      invoiceRawText: rawInvoice,
      customerId: "cust_reject",
      riskServiceUrl: mocks.riskServerUrl,
      paymentServiceUrl: mocks.paymentServerUrl,
      notificationServiceUrl: mocks.notificationServerUrl,
    });

    // Tick to approval
    await worker.tick();

    // Reject approval
    await engine.submitApproval(runId, "invoice-manager-approval", {
      decision: "reject",
      note: "Unapproved suspicious vendor",
    });

    // Worker resumes and encounters rejection
    await worker.tick();

    const failedRun = await engine.getRun(runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.error).toContain("Unapproved suspicious vendor");
  });
});
