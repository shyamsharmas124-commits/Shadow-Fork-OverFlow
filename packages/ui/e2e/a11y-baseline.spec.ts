import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { startServer } from "@durable/api";
import { type Ctx, Engine, migrate } from "@durable/engine";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { createServer, type ViteDevServer } from "vite";

const ADMIN_DB_URL = "postgres://postgres:postgres@localhost:5432/postgres";
const A11Y_DB_URL = "postgres://postgres:postgres@localhost:5432/durable_a11y";

let pool: pg.Pool;
let engine: Engine;
let apiServer: Server;
let viteServer: ViteDevServer;
let parentRunId: string;
let shadowForkId: string;
let approvalRunId: string;

const a11yResults: Record<string, any> = {};

test.beforeAll(async () => {
  const adminClient = new pg.Client({ connectionString: ADMIN_DB_URL });
  await adminClient.connect();
  await adminClient.query("DROP DATABASE IF EXISTS durable_a11y WITH (FORCE);");
  await adminClient.query("CREATE DATABASE durable_a11y;");
  await adminClient.end();

  pool = new pg.Pool({ connectionString: A11Y_DB_URL });
  await migrate(pool);

  const wfName = `wf_a11y_${randomUUID().slice(0, 8)}`;
  const approvalWfName = `wf_a11y_appr_${randomUUID().slice(0, 8)}`;

  engine = new Engine(pool, {
    [wfName]: async (ctx: Ctx) => {
      await ctx.step("step-initialize", () => "ready", {});
      return await ctx.step(
        "step-external-payment",
        async (_input, sCtx) => {
          const res = await sCtx.http.fetch({
            url: "https://payment.example.com/v1/charges",
            headers: {
              Authorization: "Bearer secret-token",
            },
            body: { chargeAmount: 1000 },
          });
          return { res };
        },
        {},
        {
          kind: "effectful-external",
          maxAttempts: 1,
          mock: { status: 200, success: true, chargeId: "ch_mock_123" },
        },
      );
    },
    [approvalWfName]: async (ctx: Ctx) => {
      const order = await ctx.step("step-create-order", () => ({ orderId: "ord_100" }), {});
      const decision = await ctx.waitForApproval("compliance-officer", { orderId: order.orderId });
      return { order, decision };
    },
  });

  parentRunId = await engine.startRun(wfName, { note: "a11y-parent-run" });
  await engine.execute(parentRunId);

  shadowForkId = await engine.fork(parentRunId, 2, {
    input: { overrideAmount: 5000 },
    mocks: [
      {
        stepName: "step-external-payment",
        result: { status: 200, chargeId: "ch_mock_fork" },
      },
    ],
  });
  await engine.execute(shadowForkId);

  approvalRunId = await engine.startRun(approvalWfName, {});
  await engine.execute(approvalRunId);

  apiServer = startServer({
    engine,
    pool,
    port: 3000,
    host: "127.0.0.1",
  }) as unknown as Server;

  viteServer = await createServer({
    root: resolve(process.cwd()),
    server: { port: 5173 },
  });
  await viteServer.listen();
});

test.afterAll(async () => {
  if (viteServer) await viteServer.close();
  if (apiServer) apiServer.close();
  if (pool) await pool.end();

  try {
    const adminClient = new pg.Client({ connectionString: ADMIN_DB_URL });
    await adminClient.connect();
    await adminClient.query("DROP DATABASE IF EXISTS durable_a11y WITH (FORCE);");
    await adminClient.end();
  } catch (err) {
    console.warn("Failed to drop durable_a11y:", err);
  }

  // Save report to disk
  writeFileSync(
    resolve(process.cwd(), "a11y-baseline-report.json"),
    JSON.stringify(a11yResults, null, 2),
    "utf-8",
  );
});

test("A11y baseline audit: scan all views with axe", async ({ page }) => {
  // 1. Run List view
  await page.goto("http://localhost:5173");
  await page.waitForSelector('[data-testid="run-list-view"]');
  const runListScan = await new AxeBuilder({ page }).analyze();
  a11yResults["Run List View"] = {
    violationsCount: runListScan.violations.length,
    violations: runListScan.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      nodeCount: v.nodes.length,
      sampleTarget: v.nodes[0]?.target,
      sampleFailure: v.nodes[0]?.failureSummary,
    })),
  };

  // 2. Run Detail view (Shadow Fork with Provenance Banner, Task Table, Event Stream)
  const shadowRow = page.locator(`[data-testid="run-row-${shadowForkId}"]`);
  await shadowRow.click();
  await page.waitForSelector('[data-testid="run-detail-view"]');
  const runDetailScan = await new AxeBuilder({ page }).analyze();
  a11yResults["Run Detail View"] = {
    violationsCount: runDetailScan.violations.length,
    violations: runDetailScan.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      nodeCount: v.nodes.length,
      sampleTarget: v.nodes[0]?.target,
      sampleFailure: v.nodes[0]?.failureSummary,
    })),
  };

  // 3. Event Detail Inspection Panel (EffectCaptured)
  const effectEventItem = page.locator('button[data-testid^="event-item-"]', {
    hasText: "EffectCaptured",
  }).first();
  await effectEventItem.click();
  await page.waitForSelector('[data-testid="event-detail-panel"]');
  const eventDetailScan = await new AxeBuilder({ page }).analyze();
  a11yResults["Event Detail Panel"] = {
    violationsCount: eventDetailScan.violations.length,
    violations: eventDetailScan.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      nodeCount: v.nodes.length,
      sampleTarget: v.nodes[0]?.target,
      sampleFailure: v.nodes[0]?.failureSummary,
    })),
  };

  // 4. Fork Modal
  const forkBtn = page.locator('[data-testid="open-fork-modal-btn"]');
  await forkBtn.click();
  await page.waitForSelector('[data-testid="fork-modal"]');
  const forkModalScan = await new AxeBuilder({ page }).analyze();
  a11yResults["Fork Modal"] = {
    violationsCount: forkModalScan.violations.length,
    violations: forkModalScan.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      nodeCount: v.nodes.length,
      sampleTarget: v.nodes[0]?.target,
      sampleFailure: v.nodes[0]?.failureSummary,
    })),
  };
  const closeForkBtn = page.locator('[data-testid="fork-modal"]').locator("button", { hasText: "Cancel" });
  await closeForkBtn.click();

  // 5. Diff View Tab
  const diffTab = page.locator('[data-testid="tab-diff"]');
  await diffTab.click();
  await page.waitForSelector('[data-testid="diff-view"]');
  const diffScan = await new AxeBuilder({ page }).analyze();
  a11yResults["Diff View"] = {
    violationsCount: diffScan.violations.length,
    violations: diffScan.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      nodeCount: v.nodes.length,
      sampleTarget: v.nodes[0]?.target,
      sampleFailure: v.nodes[0]?.failureSummary,
    })),
  };

  // 6. Approval Gate View
  await page.goto(`http://localhost:5173/#${approvalRunId}`);
  await page.waitForSelector(`[data-testid="pending-approval-card-compliance-officer"]`);
  const approvalScan = await new AxeBuilder({ page }).analyze();
  a11yResults["Approval Gate View"] = {
    violationsCount: approvalScan.violations.length,
    violations: approvalScan.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      nodeCount: v.nodes.length,
      sampleTarget: v.nodes[0]?.target,
      sampleFailure: v.nodes[0]?.failureSummary,
    })),
  };

  console.log("A11y baseline audit finished. Summary:");
  for (const [view, data] of Object.entries(a11yResults)) {
    console.log(`- ${view}: ${data.violationsCount} violations`);
  }
  expect(Object.keys(a11yResults).length).toBe(6);
});
