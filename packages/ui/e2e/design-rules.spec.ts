import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { startServer } from "@durable/api";
import { type Ctx, Engine, migrate } from "@durable/engine";
import { expect, test, type Page } from "./fixtures.js";
import pg from "pg";
import { createServer, type ViteDevServer } from "vite";

const ADMIN_DB_URL = "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const E2E_DB_URL = "postgres://postgres:postgres@127.0.0.1:5432/durable_design_rules";
const INDEX_CSS = resolve(process.cwd(), "src/index.css");

test.describe("Design Rules & Strict Aesthetics Enforcement", () => {
  let pool: pg.Pool;
  let engine: Engine;
  let apiServer: Server;
  let viteServer: ViteDevServer;
  let testRunId: string;
  let approvalRunId: string;

  test.beforeAll(async () => {
    // 1. Create dedicated database
    const adminClient = new pg.Client({ connectionString: ADMIN_DB_URL });
    await adminClient.connect();
    await adminClient.query("DROP DATABASE IF EXISTS durable_design_rules WITH (FORCE);");
    await adminClient.query("CREATE DATABASE durable_design_rules;");
    await adminClient.end();

    // 2. Connect pool and run migrations
    pool = new pg.Pool({ connectionString: E2E_DB_URL });
    await migrate(pool);

    // 3. Define and run workflows
    const wfName = `wf_design_${randomUUID().slice(0, 8)}`;
    const approvalWfName = `wf_design_appr_${randomUUID().slice(0, 8)}`;
    engine = new Engine(pool, {
      [wfName]: async (ctx: Ctx) => {
        await ctx.step("step-initialize", () => "ready", {});
        return { ok: true };
      },
      [approvalWfName]: async (ctx: Ctx) => {
        const order = await ctx.step("step-create-order", () => ({ orderId: "ord_dr_100" }), {});
        const decision = await ctx.waitForApproval("design-reviewer", {
          orderId: order.orderId,
        });
        return { order, decision };
      },
    });

    testRunId = await engine.startRun(wfName, {});
    await engine.execute(testRunId);

    approvalRunId = await engine.startRun(approvalWfName, {});
    await engine.execute(approvalRunId);

    // 4. Start API Server on port 3000
    apiServer = startServer({
      engine,
      pool,
      port: 3000,
      host: "127.0.0.1",
    }) as unknown as Server;

    // 5. Start Vite Dev Server on port 5173
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
      await adminClient.query("DROP DATABASE IF EXISTS durable_design_rules WITH (FORCE);");
      await adminClient.end();
    } catch (err) {
      console.warn("Failed to drop durable_design_rules:", err);
    }
  });

  // ---------------------------------------------------------------------------
  // Shared design-rule checker — called by BOTH the coverage test and the
  // mutation test so they exercise the SAME code path.
  // Thresholds:
  //   gradient:    zero gradient backgroundImages anywhere
  //   pill-radius: status tags must have border-radius <= 2px
  //   purple hue:  h in [250, 340], s > 15%, l in (10%, 95%) is forbidden
  //   accent btns: at most 1 accent button per screen
  // ---------------------------------------------------------------------------
  async function checkDesignRules(page: Page, viewName: string) {
    const issues = await page.evaluate(() => {
      const errors: string[] = [];
      const allElements = Array.from(document.querySelectorAll("*")) as HTMLElement[];

      function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
        r /= 255;
        g /= 255;
        b /= 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        let h = 0;
        let s = 0;
        const l = (max + min) / 2;
        if (max !== min) {
          const d = max - min;
          s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
          switch (max) {
            case r:
              h = (g - b) / d + (g < b ? 6 : 0);
              break;
            case g:
              h = (b - r) / d + 2;
              break;
            case b:
              h = (r - g) / d + 4;
              break;
          }
          h /= 6;
        }
        return [h * 360, s, l];
      }

      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const canvasCtx = canvas.getContext("2d", { willReadFrequently: true });

      const SENTINEL = "#010203";
      function parseToRgb(str: string): [number, number, number] | null {
        if (!str || str === "none" || str === "transparent") return null;
        if (!canvasCtx) return null;
        try {
          // Set ctx.fillStyle to a sentinel before each parse; return null if it did not change
          canvasCtx.fillStyle = SENTINEL;
          canvasCtx.fillStyle = str;
          if (
            canvasCtx.fillStyle === SENTINEL &&
            str.trim().toLowerCase() !== SENTINEL &&
            str.replace(/\s+/g, "") !== "rgb(1,2,3)"
          ) {
            return null;
          }
          canvasCtx.clearRect(0, 0, 1, 1);
          canvasCtx.fillRect(0, 0, 1, 1);
          const data = canvasCtx.getImageData(0, 0, 1, 1).data;
          // Alpha 0 -> null
          if (data[3] === 0) return null;
          return [data[0]!, data[1]!, data[2]!];
        } catch {
          return null;
        }
      }

      function parseColorToHsl(str: string): [number, number, number] | null {
        const rgb = parseToRgb(str);
        if (!rgb) return null;
        return rgbToHsl(rgb[0], rgb[1], rgb[2]);
      }

      // 1. No gradient backgrounds anywhere
      for (const el of allElements) {
        const style = window.getComputedStyle(el);
        const bg = style.backgroundImage;
        if (bg && bg !== "none" && /gradient/i.test(bg)) {
          errors.push(
            `Gradient background detected on <${el.tagName.toLowerCase()} class="${el.className}">: ${bg}`,
          );
        }
      }

      // 2. Status tag border-radius <= 2px (square tags, no pill badges)
      const statusTags = Array.from(
        document.querySelectorAll(
          '[data-testid*="status"], [class*="status"], [data-testid="badge"], .badge',
        ),
      ) as HTMLElement[];

      for (const el of statusTags) {
        const style = window.getComputedStyle(el);
        const tl = Number.parseFloat(style.borderTopLeftRadius) || 0;
        const tr = Number.parseFloat(style.borderTopRightRadius) || 0;
        const bl = Number.parseFloat(style.borderBottomLeftRadius) || 0;
        const br = Number.parseFloat(style.borderBottomRightRadius) || 0;
        if (tl > 2 || tr > 2 || bl > 2 || br > 2) {
          errors.push(
            `Status tag border-radius exceeds 2px on <${el.tagName.toLowerCase()} class="${el.className}">: [tl:${tl}, tr:${tr}, bl:${bl}, br:${br}]`,
          );
        }
      }

      // 3. No purple or magenta hue (h in [250, 340], s > 15%, l in (10%, 95%))
      for (const el of allElements) {
        const style = window.getComputedStyle(el);
        // getPropertyValue requires hyphenated CSS property names, not camelCase
        for (const [cssProp, label] of [
          ["color", "color"],
          ["background-color", "backgroundColor"],
          ["border-color", "borderColor"],
        ] as const) {
          const val = style.getPropertyValue(cssProp);
          const hsl = parseColorToHsl(val);
          if (hsl) {
            const [h, s, l] = hsl;
            if (s > 0.15 && l > 0.1 && l < 0.95 && h >= 250 && h <= 340) {
              errors.push(
                `Forbidden purple/magenta hue (${Math.round(h)}deg, s=${Math.round(s * 100)}%) in ${label} on <${el.tagName.toLowerCase()} class="${el.className}">: ${val}`,
              );
            }
          }
        }
      }

      // 4. Accent button count <= 1 per screen
      const buttons = Array.from(
        document.querySelectorAll("button, [role='button']"),
      ) as HTMLElement[];
      let accentBtnCount = 0;
      for (const btn of buttons) {
        const style = window.getComputedStyle(btn);
        const bg = style.backgroundColor;
        if (
          bg.includes("184, 58, 27") ||
          bg.includes("196, 69, 39") ||
          btn.classList.contains("bg-[var(--accent)]")
        ) {
          accentBtnCount++;
        }
      }
      if (accentBtnCount > 1) {
        errors.push(`More than 1 accent button per screen: found ${accentBtnCount}`);
      }

      return errors;
    });

    expect(issues, `Design rule violations in ${viewName}:\n${issues.join("\n")}`).toEqual([]);
  }

  // ---------------------------------------------------------------------------
  // Test 01: Run checker across all 9 main surfaces in both themes
  // ---------------------------------------------------------------------------
  test("01. Design rules hold on all 9 surfaces (run list, run detail, diff view, fork modal, export modal, compare modal, worker view, command palette, approval gate) in light and dark", async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.goto("http://localhost:5173");
    await page.waitForSelector('[data-testid="run-list-view"]', { timeout: 15000 });

    // Surface 1: Run List (Light)
    await checkDesignRules(page, "Run List (Light)");

    // Surface 2: Run List (Dark)
    await page.evaluate(() => {
      document.documentElement.classList.add("dark");
      document.documentElement.setAttribute("data-theme", "dark");
    });
    await checkDesignRules(page, "Run List (Dark)");
    await page.evaluate(() => {
      document.documentElement.classList.remove("dark");
      document.documentElement.setAttribute("data-theme", "light");
    });

    // Surface 3: Run Detail (Light) — row must exist; fail loudly if not
    const runRow = page.locator(`[data-testid="run-row-${testRunId}"]`);
    await runRow.click();
    await page.waitForSelector('[data-testid="run-detail-view"]');

    // Assert lineage graph has non-zero size on Run Detail
    const detailLineage = page.locator('[data-testid="lineage-graph-container"]');
    await expect(detailLineage).toBeVisible();
    const detailLineageBox = await detailLineage.boundingBox();
    expect(detailLineageBox).not.toBeNull();
    expect(detailLineageBox!.width).toBeGreaterThan(0);
    expect(detailLineageBox!.height).toBeGreaterThan(0);

    await checkDesignRules(page, "Run Detail (Light)");

    // Surface 4: Run Detail (Dark)
    await page.evaluate(() => {
      document.documentElement.classList.add("dark");
      document.documentElement.setAttribute("data-theme", "dark");
    });
    await checkDesignRules(page, "Run Detail (Dark)");
    await page.evaluate(() => {
      document.documentElement.classList.remove("dark");
      document.documentElement.setAttribute("data-theme", "light");
    });

    // Surface 5: Diff View
    const diffTab = page.locator('[data-testid="tab-diff"]');
    await diffTab.click();
    await page.waitForSelector('[data-testid="diff-view"]');

    // Assert lineage graph has non-zero size on Diff View
    const diffLineage = page.locator('[data-testid="lineage-graph-container"]');
    await expect(diffLineage).toBeVisible();
    const diffLineageBox = await diffLineage.boundingBox();
    expect(diffLineageBox).not.toBeNull();
    expect(diffLineageBox!.width).toBeGreaterThan(0);
    expect(diffLineageBox!.height).toBeGreaterThan(0);

    await checkDesignRules(page, "Diff View (Light)");
    await page.evaluate(() => {
      document.documentElement.classList.add("dark");
      document.documentElement.setAttribute("data-theme", "dark");
    });
    await checkDesignRules(page, "Diff View (Dark)");
    await page.evaluate(() => {
      document.documentElement.classList.remove("dark");
      document.documentElement.setAttribute("data-theme", "light");
    });

    // Surface 6: Fork Modal
    const forkBtn = page.locator('[data-testid="open-fork-modal-btn"]');
    await forkBtn.click();
    await page.waitForSelector('[data-testid="fork-modal"]');
    await checkDesignRules(page, "Fork Modal (Light)");
    await page.evaluate(() => {
      document.documentElement.classList.add("dark");
      document.documentElement.setAttribute("data-theme", "dark");
    });
    await checkDesignRules(page, "Fork Modal (Dark)");
    await page.evaluate(() => {
      document.documentElement.classList.remove("dark");
      document.documentElement.setAttribute("data-theme", "light");
    });
    await page
      .locator('[data-testid="fork-modal"]')
      .locator('button[aria-label="Close modal"]')
      .click();
    await page.locator('[data-testid="fork-modal"]').waitFor({ state: "detached" });

    // Surface 7: Export Modal
    const exportBtn = page.locator('[data-testid="open-export-btn"]');
    await exportBtn.click();
    await page.waitForSelector('[data-testid="run-export-modal"]');
    await checkDesignRules(page, "Export Modal (Light)");
    await page.evaluate(() => {
      document.documentElement.classList.add("dark");
      document.documentElement.setAttribute("data-theme", "dark");
    });
    await checkDesignRules(page, "Export Modal (Dark)");
    await page.evaluate(() => {
      document.documentElement.classList.remove("dark");
      document.documentElement.setAttribute("data-theme", "light");
    });
    await page.locator('[data-testid="close-export-modal-btn"]').click();
    await page.locator('[data-testid="run-export-modal"]').waitFor({ state: "detached" });

    // Surface 8: Compare Runs Modal
    const compareBtn = page.locator('[data-testid="top-compare-btn"]');
    await compareBtn.click();
    await page.waitForSelector('[data-testid="compare-runs-modal"]');

    // Assert lineage graph has non-zero size in Compare view
    const compareLineage = page.locator('[data-testid="compare-runs-modal"] [data-testid="lineage-graph-container"]');
    await expect(compareLineage).toBeVisible();
    const compareLineageBox = await compareLineage.boundingBox();
    expect(compareLineageBox).not.toBeNull();
    expect(compareLineageBox!.width).toBeGreaterThan(0);
    expect(compareLineageBox!.height).toBeGreaterThan(0);
    await checkDesignRules(page, "Compare Modal (Light)");
    await page.evaluate(() => {
      document.documentElement.classList.add("dark");
      document.documentElement.setAttribute("data-theme", "dark");
    });
    await checkDesignRules(page, "Compare Modal (Dark)");
    await page.evaluate(() => {
      document.documentElement.classList.remove("dark");
      document.documentElement.setAttribute("data-theme", "light");
    });
    await page
      .locator('[data-testid="compare-runs-modal"]')
      .locator('button[aria-label="Close dialog"]')
      .click();
    await page.locator('[data-testid="compare-runs-modal"]').waitFor({ state: "detached" });

    // Surface 9: Worker View Modal
    const workersBtn = page.locator('[data-testid="open-workers-modal-btn"]');
    await workersBtn.click();
    await page.waitForSelector('[data-testid="worker-pool-modal"]');
    await checkDesignRules(page, "Worker View (Light)");
    await page.evaluate(() => {
      document.documentElement.classList.add("dark");
      document.documentElement.setAttribute("data-theme", "dark");
    });
    await checkDesignRules(page, "Worker View (Dark)");
    await page.evaluate(() => {
      document.documentElement.classList.remove("dark");
      document.documentElement.setAttribute("data-theme", "light");
    });
    await page
      .locator('[data-testid="worker-pool-modal"]')
      .locator('button[aria-label="Close dialog"]')
      .click();
    await page.locator('[data-testid="worker-pool-modal"]').waitFor({ state: "detached" });

    // Surface 10: Command Palette
    const cmdBtn = page.locator('[data-testid="quick-command-palette-btn"]');
    await cmdBtn.click();
    await page.waitForSelector('[data-testid="command-palette"]');
    await checkDesignRules(page, "Command Palette (Light)");
    await page.evaluate(() => {
      document.documentElement.classList.add("dark");
      document.documentElement.setAttribute("data-theme", "dark");
    });
    await checkDesignRules(page, "Command Palette (Dark)");
    await page.keyboard.press("Escape");
    await page.locator('[data-testid="command-palette"]').waitFor({ state: "detached" });
    await page.evaluate(() => {
      document.documentElement.classList.remove("dark");
      document.documentElement.setAttribute("data-theme", "light");
    });

    // Surface 11: Approval Gate View
    await page.goto(`http://localhost:5173/#${approvalRunId}`);
    await page.waitForSelector('[data-testid="pending-approval-card-design-reviewer"]');
    await checkDesignRules(page, "Approval Gate (Light)");
    await page.evaluate(() => {
      document.documentElement.classList.add("dark");
      document.documentElement.setAttribute("data-theme", "dark");
    });
    await checkDesignRules(page, "Approval Gate (Dark)");
  });

  // ---------------------------------------------------------------------------
  // Test 02: Mutation — real gradient injected into index.css via filesystem,
  // then the SAME checkDesignRules helper (not a manual element check) must
  // report it.  After restore, it must pass again.
  // ---------------------------------------------------------------------------
  test("02. Real gradient mutation in index.css fails checker, restore passes", async ({
    page,
  }) => {
    const originalCss = readFileSync(INDEX_CSS, "utf-8");
    // Inject a gradient on the :root body background — a real CSS change served by Vite HMR
    const mutatedCss = originalCss.replace(
      "--bg-page: #f8f5ee;",
      "--bg-page: #f8f5ee;\n  background-image: linear-gradient(to right, #ff0000, #00ff00);",
    );

    try {
      writeFileSync(INDEX_CSS, mutatedCss, "utf-8");
      // Wait for Vite HMR to push the update (up to 4 s)
      await page.goto("http://localhost:5173");
      await page.waitForSelector('[data-testid="run-list-view"]');
      await page.waitForTimeout(2000);

      // The SAME checkDesignRules helper must now throw because the body has a gradient
      let threw = false;
      let thrownMessage = "";
      try {
        await checkDesignRules(page, "Gradient Mutation (should FAIL)");
      } catch (e) {
        threw = true;
        thrownMessage = (e as Error).message;
      }
      expect(
        threw,
        `checkDesignRules should have thrown for gradient mutation but did not. checker output: ${thrownMessage}`,
      ).toBe(true);
      expect(thrownMessage).toContain("Gradient background detected");
    } finally {
      // Always restore, even if the expect above fails
      writeFileSync(INDEX_CSS, originalCss, "utf-8");
    }

    // After restore: same helper must pass
    await page.goto("http://localhost:5173");
    await page.waitForSelector('[data-testid="run-list-view"]');
    await page.waitForTimeout(2000);
    await checkDesignRules(page, "Gradient Mutation Restored (should PASS)");
  });

  // ---------------------------------------------------------------------------
  // Test 03: In-page injection mutations — checker detects pill radius, purple,
  // and two accent buttons; uses the SAME checkDesignRules helper.
  // ---------------------------------------------------------------------------
  test("03. In-page violation mutations: pill radius, purple formats (Tailwind class, oklch, color-mix), two accent buttons all detected by shared checker", async ({
    page,
  }) => {
    await page.goto("http://localhost:5173");
    await page.waitForSelector('[data-testid="run-list-view"]');

    // Mutation A: pill-radius status tag
    await page.evaluate(() => {
      const tag = document.createElement("span");
      tag.setAttribute("data-testid", "status-pill-mutation");
      tag.style.borderRadius = "12px";
      tag.id = "mut-pill";
      document.body.appendChild(tag);
    });
    const pillRadius = await page
      .locator("#mut-pill")
      .evaluate((el) => window.getComputedStyle(el).borderRadius);
    console.log("Mutation computed border-radius (pill):", pillRadius);
    let threw = false;
    let msg = "";
    try {
      await checkDesignRules(page, "Pill mutation (FAIL)");
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    expect(threw, "Pill radius mutation not caught").toBe(true);
    expect(msg).toContain("border-radius exceeds 2px");
    await page.evaluate(() => document.getElementById("mut-pill")?.remove());

    // Mutation B1: Tailwind purple class (bg-purple-600)
    await page.evaluate(() => {
      const el = document.createElement("div");
      el.id = "mut-purple-tw";
      el.className = "bg-purple-600";
      document.body.appendChild(el);
    });
    const twComputedColor = await page
      .locator("#mut-purple-tw")
      .evaluate((el) => window.getComputedStyle(el).backgroundColor);
    console.log("Mutation computed colour (Tailwind bg-purple-600):", twComputedColor);
    threw = false;
    msg = "";
    try {
      await checkDesignRules(page, "Tailwind purple class mutation (FAIL)");
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    expect(threw, "Tailwind bg-purple-600 mutation not caught").toBe(true);
    expect(msg).toContain("purple/magenta");
    await page.evaluate(() => document.getElementById("mut-purple-tw")?.remove());

    // Mutation B2: oklch(0.55 0.25 300)
    await page.evaluate(() => {
      const el = document.createElement("div");
      el.id = "mut-purple-oklch";
      el.style.backgroundColor = "oklch(0.55 0.25 300)";
      document.body.appendChild(el);
    });
    const oklchComputedColor = await page
      .locator("#mut-purple-oklch")
      .evaluate((el) => window.getComputedStyle(el).backgroundColor);
    console.log("Mutation computed colour (oklch(0.55 0.25 300)):", oklchComputedColor);
    threw = false;
    msg = "";
    try {
      await checkDesignRules(page, "oklch purple mutation (FAIL)");
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    expect(threw, "oklch purple mutation not caught").toBe(true);
    expect(msg).toContain("purple/magenta");
    await page.evaluate(() => document.getElementById("mut-purple-oklch")?.remove());

    // Mutation B3: color-mix purple
    await page.evaluate(() => {
      const el = document.createElement("div");
      el.id = "mut-purple-colormix";
      el.style.backgroundColor = "color-mix(in srgb, purple 50%, blue 50%)";
      document.body.appendChild(el);
    });
    const colormixComputedColor = await page
      .locator("#mut-purple-colormix")
      .evaluate((el) => window.getComputedStyle(el).backgroundColor);
    console.log(
      "Mutation computed colour (color-mix(in srgb, purple 50%, blue 50%)):",
      colormixComputedColor,
    );
    threw = false;
    msg = "";
    try {
      await checkDesignRules(page, "color-mix purple mutation (FAIL)");
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    expect(threw, "color-mix purple mutation not caught").toBe(true);
    expect(msg).toContain("purple/magenta");
    await page.evaluate(() => document.getElementById("mut-purple-colormix")?.remove());

    // Mutation C: two accent buttons
    await page.evaluate(() => {
      const b1 = document.createElement("button");
      b1.id = "mut-btn1";
      b1.style.backgroundColor = "rgb(184, 58, 27)";
      const b2 = document.createElement("button");
      b2.id = "mut-btn2";
      b2.style.backgroundColor = "rgb(184, 58, 27)";
      document.body.appendChild(b1);
      document.body.appendChild(b2);
    });
    const btn1ComputedColor = await page
      .locator("#mut-btn1")
      .evaluate((el) => window.getComputedStyle(el).backgroundColor);
    console.log("Mutation computed colour (accent button 1):", btn1ComputedColor);
    threw = false;
    try {
      await checkDesignRules(page, "Two accent buttons mutation (FAIL)");
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    expect(threw, "Two accent buttons mutation not caught").toBe(true);
    expect(msg).toContain("More than 1 accent button");
    await page.evaluate(() => {
      document.getElementById("mut-btn1")?.remove();
      document.getElementById("mut-btn2")?.remove();
    });
  });

  // ---------------------------------------------------------------------------
  // Test 04: Exactly one Paprika accent element per screen across all 9 surfaces in light and dark
  // ---------------------------------------------------------------------------
  test("04. Paprika accent element rules across all 9 surfaces in light and dark", async ({
    page,
  }) => {
    // Helper to count visible elements carrying the Paprika accent background
    async function countPaprikaAccentElements(): Promise<number> {
      return await page.evaluate(() => {
        const all = Array.from(
          document.querySelectorAll("button, [role='button'], a, input[type='submit']"),
        ) as HTMLElement[];
        return all.filter((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          const bg = window.getComputedStyle(el).backgroundColor;
          return bg.includes("184, 58, 27") || bg.includes("196, 69, 39");
        }).length;
      });
    }

    async function applyTheme(theme: "light" | "dark") {
      await page.evaluate((t) => {
        document.documentElement.setAttribute("data-theme", t);
        if (t === "dark") {
          document.documentElement.classList.add("dark");
        } else {
          document.documentElement.classList.remove("dark");
        }
      }, theme);
    }

    for (const theme of ["light", "dark"] as const) {
      // Surface 1: Run List (no primary action)
      await page.goto("http://localhost:5173");
      await applyTheme(theme);
      await page.waitForSelector('[data-testid="run-list-view"]');
      expect(
        await countPaprikaAccentElements(),
        `Run List (${theme}) has no primary accent button`,
      ).toBe(0);

      // Surface 2: Run Detail (primary action is Fork Run button)
      const runRow = page.locator(`[data-testid="run-row-${testRunId}"]`);
      await runRow.click();
      await page.waitForSelector('[data-testid="run-detail-view"]');
      expect(
        await countPaprikaAccentElements(),
        `Run Detail (${theme}) must have exactly 1 Paprika accent element`,
      ).toBe(1);
      const forkBtn = page.locator('[data-testid="open-fork-modal-btn"]');
      await expect(forkBtn).toBeVisible();
      await expect(forkBtn).toHaveCSS(
        "background-color",
        theme === "dark" ? "rgb(196, 69, 39)" : "rgb(184, 58, 27)",
      );

      // Surface 3: Diff View (primary action remains header Fork Run button)
      const diffTab = page.locator('[data-testid="tab-diff"]');
      await diffTab.click();
      await page.waitForSelector('[data-testid="diff-view"]');
      expect(
        await countPaprikaAccentElements(),
        `Diff View (${theme}) must have exactly 1 Paprika accent element`,
      ).toBe(1);

      // Surface 4: Fork Modal Open (sole primary accent transfers to Submit Fork button)
      await forkBtn.click();
      await page.waitForSelector('[data-testid="fork-modal"]');
      expect(
        await countPaprikaAccentElements(),
        `Fork Modal open (${theme}) must have exactly 1 Paprika accent element`,
      ).toBe(1);
      const submitForkBtn = page.locator('[data-testid="submit-fork-btn"]');
      await expect(submitForkBtn).toBeVisible();
      await expect(submitForkBtn).toHaveCSS(
        "background-color",
        theme === "dark" ? "rgb(196, 69, 39)" : "rgb(184, 58, 27)",
      );
      await expect(forkBtn).not.toHaveCSS(
        "background-color",
        theme === "dark" ? "rgb(196, 69, 39)" : "rgb(184, 58, 27)",
      );
      await page
        .locator('[data-testid="fork-modal"]')
        .locator('button[aria-label="Close modal"]')
        .click();
      await page.locator('[data-testid="fork-modal"]').waitFor({ state: "detached" });

      // Surface 5: Export Modal
      const exportBtn = page.locator('[data-testid="open-export-btn"]');
      await exportBtn.click();
      await page.waitForSelector('[data-testid="run-export-modal"]');
      expect(
        await countPaprikaAccentElements(),
        `Export Modal (${theme}) has exactly 1 Paprika accent element on screen (header fork button)`,
      ).toBe(1);
      await expect(forkBtn).toBeVisible();
      await expect(forkBtn).toHaveCSS(
        "background-color",
        theme === "dark" ? "rgb(196, 69, 39)" : "rgb(184, 58, 27)",
      );
      const closeExportBtn = page.locator('[data-testid="close-export-modal-btn"]');
      await closeExportBtn.click();
      await page.locator('[data-testid="run-export-modal"]').waitFor({ state: "detached" });

      // Surface 6: Compare Modal
      const compareBtn = page.locator('[data-testid="top-compare-btn"]');
      await compareBtn.click();
      await page.waitForSelector('[data-testid="compare-runs-modal"]');
      expect(
        await countPaprikaAccentElements(),
        `Compare Modal (${theme}) has exactly 1 Paprika accent element on screen (header fork button)`,
      ).toBe(1);
      await expect(forkBtn).toBeVisible();
      await expect(forkBtn).toHaveCSS(
        "background-color",
        theme === "dark" ? "rgb(196, 69, 39)" : "rgb(184, 58, 27)",
      );
      await page
        .locator('[data-testid="compare-runs-modal"]')
        .locator('button[aria-label="Close dialog"]')
        .click();
      await page.locator('[data-testid="compare-runs-modal"]').waitFor({ state: "detached" });

      // Surface 7: Worker View Modal
      const workersBtn = page.locator('[data-testid="open-workers-modal-btn"]');
      await workersBtn.click();
      await page.waitForSelector('[data-testid="worker-pool-modal"]');
      expect(
        await countPaprikaAccentElements(),
        `Worker View Modal (${theme}) has exactly 1 Paprika accent element on screen (header fork button)`,
      ).toBe(1);
      await expect(forkBtn).toBeVisible();
      await expect(forkBtn).toHaveCSS(
        "background-color",
        theme === "dark" ? "rgb(196, 69, 39)" : "rgb(184, 58, 27)",
      );
      await page
        .locator('[data-testid="worker-pool-modal"]')
        .locator('button[aria-label="Close dialog"]')
        .click();
      await page.locator('[data-testid="worker-pool-modal"]').waitFor({ state: "detached" });

      // Surface 8: Command Palette Modal
      const cmdBtn = page.locator('[data-testid="quick-command-palette-btn"]');
      await cmdBtn.click();
      await page.waitForSelector('[data-testid="command-palette"]');
      expect(
        await countPaprikaAccentElements(),
        `Command Palette Modal (${theme}) has exactly 1 Paprika accent element on screen (header fork button)`,
      ).toBe(1);
      await expect(forkBtn).toBeVisible();
      await expect(forkBtn).toHaveCSS(
        "background-color",
        theme === "dark" ? "rgb(196, 69, 39)" : "rgb(184, 58, 27)",
      );
      await page.keyboard.press("Escape");
      await page.locator('[data-testid="command-palette"]').waitFor({ state: "detached" });

      // Surface 9: Approval Gate run page
      await page.goto(`http://localhost:5173/#${approvalRunId}`);
      await applyTheme(theme);
      await page.waitForSelector('[data-testid="pending-approval-card-design-reviewer"]');
      expect(
        await countPaprikaAccentElements(),
        `Approval Gate run page (${theme}) must have exactly 1 Paprika accent element`,
      ).toBe(1);
      const approveBtn = page.locator('[data-testid="approve-btn-design-reviewer"]');
      await expect(approveBtn).toBeVisible();
      await expect(approveBtn).toHaveCSS(
        "background-color",
        theme === "dark" ? "rgb(196, 69, 39)" : "rgb(184, 58, 27)",
      );
      const gateForkBtn = page.locator('[data-testid="open-fork-modal-btn"]');
      await expect(gateForkBtn).toBeVisible();
      await expect(gateForkBtn).not.toHaveCSS(
        "background-color",
        theme === "dark" ? "rgb(196, 69, 39)" : "rgb(184, 58, 27)",
      );
    }
  });
});
