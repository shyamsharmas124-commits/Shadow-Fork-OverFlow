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
const A11Y_DB_URL = "postgres://postgres:postgres@localhost:5432/durable_a11y_stage1";

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
  await adminClient.query("DROP DATABASE IF EXISTS durable_a11y_stage1 WITH (FORCE);");
  await adminClient.query("CREATE DATABASE durable_a11y_stage1;");
  await adminClient.end();

  pool = new pg.Pool({ connectionString: A11Y_DB_URL });
  await migrate(pool);

  const wfName = `wf_a11y_s1_${randomUUID().slice(0, 8)}`;
  const approvalWfName = `wf_a11y_appr_s1_${randomUUID().slice(0, 8)}`;

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
    await adminClient.query("DROP DATABASE IF EXISTS durable_a11y_stage1 WITH (FORCE);");
    await adminClient.end();
  } catch (err) {
    console.warn("Failed to drop durable_a11y_stage1:", err);
  }

  writeFileSync(
    resolve(process.cwd(), "a11y-stage1-report.json"),
    JSON.stringify(a11yResults, null, 2),
    "utf-8",
  );
});

async function runAxeOnView(page: any, viewName: string) {
  // Test Light Mode
  await page.evaluate(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.setAttribute("data-theme", "light");
  });
  await page.waitForTimeout(200);
  const lightScan = await new AxeBuilder({ page }).analyze();
  a11yResults[`${viewName} (Light)`] = {
    violationsCount: lightScan.violations.length,
    violations: lightScan.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      nodeCount: v.nodes.length,
      sampleFailure: v.nodes[0]?.failureSummary,
      targets: v.nodes.map((n) => n.target),
    })),
  };

  // Test Dark Mode
  await page.evaluate(() => {
    document.documentElement.classList.add("dark");
    document.documentElement.setAttribute("data-theme", "dark");
  });
  await page.waitForTimeout(200);
  const darkScan = await new AxeBuilder({ page }).analyze();
  a11yResults[`${viewName} (Dark)`] = {
    violationsCount: darkScan.violations.length,
    violations: darkScan.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      nodeCount: v.nodes.length,
      sampleFailure: v.nodes[0]?.failureSummary,
      targets: v.nodes.map((n) => n.target),
    })),
  };
}

test("A11y Stage 1 audit: scan all views in Light and Dark mode with axe", async ({ page }) => {
  // 1. Run List view
  await page.goto("http://localhost:5173");
  await page.waitForSelector('[data-testid="run-list-view"]');
  await runAxeOnView(page, "Run List View");

  // 2. Run Detail view
  const shadowRow = page.locator(`[data-testid="run-row-${shadowForkId}"]`);
  await shadowRow.click();
  await page.waitForSelector('[data-testid="run-detail-view"]');
  await runAxeOnView(page, "Run Detail View");

  // 3. Event Detail Inspection Panel
  const effectEventItem = page.locator('button[data-testid^="event-item-"]', {
    hasText: "EffectCaptured",
  }).first();
  await effectEventItem.click();
  await page.waitForSelector('[data-testid="event-detail-panel"]');
  await runAxeOnView(page, "Event Detail Panel");

  // 4. Fork Modal
  const forkBtn = page.locator('[data-testid="open-fork-modal-btn"]');
  await forkBtn.click();
  await page.waitForSelector('[data-testid="fork-modal"]');
  await runAxeOnView(page, "Fork Modal");
  const closeForkBtn = page
    .locator('[data-testid="fork-modal"]')
    .locator('button[aria-label="Close modal"]');
  await closeForkBtn.click();

  // 5. Diff View Tab
  const diffTab = page.locator('[data-testid="tab-diff"]');
  await diffTab.click();
  await page.waitForSelector('[data-testid="diff-view"]');
  await runAxeOnView(page, "Diff View");

  // 6. Approval Gate View
  await page.goto(`http://localhost:5173/#${approvalRunId}`);
  await page.waitForSelector(`[data-testid="pending-approval-card-compliance-officer"]`);
  await runAxeOnView(page, "Approval Gate View");

  console.log("Stage 1 A11y scan finished across light and dark modes:");
  for (const [view, data] of Object.entries(a11yResults)) {
    console.log(`- ${view}: ${data.violationsCount} violations`);
  }
  expect(Object.keys(a11yResults).length).toBe(12);
});
