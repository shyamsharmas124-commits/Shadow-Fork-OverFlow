import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { startServer } from "@durable/api";
import { type Ctx, Engine, migrate } from "@durable/engine";
import { expect, test, type Page } from "./fixtures.js";
import pg from "pg";
import { createServer, type ViteDevServer } from "vite";

const ADMIN_DB_URL = "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const A11Y_DB_URL = "postgres://postgres:postgres@127.0.0.1:5432/durable_a11y";

let pool: pg.Pool;
let engine: Engine;
let apiServer: Server;
let viteServer: ViteDevServer;
let parentRunId: string;
let shadowForkId: string;
let approvalRunId: string;

const a11yResults: Record<string, unknown> = {};

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

// Scans the WHOLE PAGE (no .include scoping) so header, status bar and footer are covered.
async function scanWholePage(page: Page, viewName: string) {
  await page.waitForTimeout(200);
  const scan = await new AxeBuilder({ page }).analyze();
  a11yResults[viewName] = {
    violationsCount: scan.violations.length,
    violations: scan.violations.map((v) => ({
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
  expect(
    scan.violations,
    `${viewName}: axe violations found:\n${scan.violations.map((v) => `  [${v.id}] ${v.help} (${v.nodes.length} nodes)`).join("\n")}`,
  ).toHaveLength(0);
}

test("A11y baseline audit: scan all views with axe (whole page, 0 violations)", async ({
  page,
}) => {
  test.setTimeout(180000);

  // 1. Run List view
  await page.goto("http://localhost:5173");
  await page.waitForSelector('[data-testid="run-list-view"]');
  await scanWholePage(page, "Run List View");

  // 2. Run Detail view (Shadow Fork with Provenance Banner, Task Table, Event Stream)
  const shadowRow = page.locator(`[data-testid="run-row-${shadowForkId}"]`);
  await shadowRow.click();
  await page.waitForSelector('[data-testid="run-detail-view"]');
  await scanWholePage(page, "Run Detail View");

  // 3. Event Detail Inspection Panel (EffectCaptured)
  const effectEventItem = page
    .locator('button[data-testid^="event-item-"]', {
      hasText: "EffectCaptured",
    })
    .first();
  await effectEventItem.click();
  await page.waitForSelector('[data-testid="event-detail-panel"]');
  await scanWholePage(page, "Event Detail Panel");

  // 4. Fork Modal
  const forkBtn = page.locator('[data-testid="open-fork-modal-btn"]');
  await forkBtn.click();
  await page.waitForSelector('[data-testid="fork-modal"]');
  await scanWholePage(page, "Fork Modal");
  const closeForkBtn = page
    .locator('[data-testid="fork-modal"]')
    .locator("button", { hasText: "Cancel" });
  await closeForkBtn.click();

  // 5. Diff View Tab
  const diffTab = page.locator('[data-testid="tab-diff"]');
  await diffTab.click();
  await page.waitForSelector('[data-testid="diff-view"]');
  await scanWholePage(page, "Diff View");

  // 6. Approval Gate View
  await page.goto(`http://localhost:5173/#${approvalRunId}`);
  await page.waitForSelector('[data-testid="run-detail-view"]');
  await page.waitForSelector(`[data-testid="pending-approval-card-compliance-officer"]`);
  await scanWholePage(page, "Approval Gate View");

  console.log("A11y baseline audit finished. Summary:");
  for (const [view, data] of Object.entries(a11yResults)) {
    const d = data as { violationsCount: number };
    console.log(`- ${view}: ${d.violationsCount} violations`);
  }
  expect(Object.keys(a11yResults).length).toBe(6);
});
