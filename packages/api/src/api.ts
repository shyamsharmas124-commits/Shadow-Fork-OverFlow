import { timingSafeEqual } from "node:crypto";
import {
  appendEvent,
  type Engine,
  type ForkEdit,
  type ForkMocksOption,
  loadEvents,
  reapTasks,
  redactApiOutput,
  type StoredEvent,
} from "@durable/engine";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Pool } from "pg";
import { z } from "zod";

export interface CreateApiOptions {
  engine: Engine;
  pool: Pool;
  corsOrigin?: string;
  maxLimit?: number;
  apiToken?: string;
  host?: string;
}

export function safeCompareTokens(provided: string, expected: string): boolean {
  const bufA = Buffer.from(provided, "utf-8");
  const bufB = Buffer.from(expected, "utf-8");
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function isLoopback(host?: string): boolean {
  if (!host) return true;
  let h = host.toLowerCase().trim();
  // Handle bracketed IPv6: [::1]:3000 or [::1] -> ::1
  if (h.startsWith("[")) {
    const bracketEnd = h.indexOf("]");
    if (bracketEnd !== -1) {
      h = h.slice(1, bracketEnd);
    }
  } else if (h.includes(":") && !h.includes("::")) {
    // IPv4 or hostname with port: 127.0.0.1:3000 -> 127.0.0.1, localhost:3000 -> localhost
    h = h.split(":")[0]!;
  }
  if (h === "localhost" || h === "::1") return true;
  return /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(h);
}

export interface EffectDiffItem {
  stepName: string;
  occurrence: number;
  reusedFromParent: boolean;
  inputChangedFromParent: boolean;
  status: "reused" | "modified" | "added" | "live";
  parent: {
    seq?: number;
    input?: unknown;
    result?: unknown;
    effects: Array<{
      kind: string;
      request: unknown;
      wouldHaveResult?: unknown;
      resultSource?: string;
    }>;
  } | null;
  shadow: {
    seq?: number;
    input?: unknown;
    result?: unknown;
    effects: Array<{
      kind: string;
      request: unknown;
      wouldHaveResult?: unknown;
      resultSource?: string;
      reusedFromParent?: boolean;
      inputChangedFromParent?: boolean;
    }>;
  } | null;
}

export function buildEffectDiff(
  run: { id: string; parent_run_id: string | null; forked_from_seq: number | null },
  shadowEvents: StoredEvent[],
  parentEvents: StoredEvent[],
): EffectDiffItem[] {
  if (!run.parent_run_id) {
    const items: EffectDiffItem[] = [];
    const occurrences: Record<string, number> = {};

    let currentStep: {
      name: string;
      occurrence: number;
      input: unknown;
      result?: unknown;
      effects: Array<{
        kind: string;
        request: unknown;
        wouldHaveResult?: unknown;
        resultSource?: string;
      }>;
    } | null = null;

    for (const ev of shadowEvents) {
      if (ev.type === "StepCompleted") {
        const payload = ev.payload as { name: string; input: unknown; result: unknown };
        const occ = occurrences[payload.name] ?? 0;
        occurrences[payload.name] = occ + 1;
        items.push({
          stepName: payload.name,
          occurrence: occ,
          reusedFromParent: false,
          inputChangedFromParent: false,
          status: "live",
          parent: null,
          shadow: {
            seq: ev.seq,
            input: payload.input,
            result: payload.result,
            effects: currentStep?.name === payload.name ? currentStep.effects : [],
          },
        });
        currentStep = null;
      } else if (ev.type === "EffectCaptured") {
        const p = ev.payload as {
          stepName: string;
          kind: string;
          request: unknown;
          wouldHaveResult?: unknown;
          resultSource?: string;
        };
        if (!currentStep || currentStep.name !== p.stepName) {
          const occ = occurrences[p.stepName] ?? 0;
          currentStep = { name: p.stepName, occurrence: occ, input: undefined, effects: [] };
        }
        currentStep.effects.push({
          kind: p.kind,
          request: p.request,
          wouldHaveResult: p.wouldHaveResult,
          resultSource: p.resultSource,
        });
      }
    }
    return items;
  }

  interface StepInfo {
    seq: number;
    name: string;
    occurrence: number;
    input: unknown;
    result: unknown;
    effects: Array<{
      kind: string;
      request: unknown;
      wouldHaveResult?: unknown;
      resultSource?: string;
      reusedFromParent?: boolean;
      inputChangedFromParent?: boolean;
    }>;
  }

  function extractSteps(events: StoredEvent[]): StepInfo[] {
    const list: StepInfo[] = [];
    const occMap: Record<string, number> = {};
    const pendingEffects: Record<string, StepInfo["effects"]> = {};

    for (const ev of events) {
      if (ev.type === "EffectCaptured") {
        const p = ev.payload as {
          stepName: string;
          kind: string;
          request: unknown;
          wouldHaveResult?: unknown;
          resultSource?: string;
          reusedFromParent?: boolean;
          inputChangedFromParent?: boolean;
        };
        if (!pendingEffects[p.stepName]) {
          pendingEffects[p.stepName] = [];
        }
        pendingEffects[p.stepName]!.push({
          kind: p.kind,
          request: p.request,
          wouldHaveResult: p.wouldHaveResult,
          resultSource: p.resultSource,
          reusedFromParent: p.reusedFromParent,
          inputChangedFromParent: p.inputChangedFromParent,
        });
      } else if (ev.type === "StepCompleted") {
        const p = ev.payload as { name: string; input: unknown; result: unknown };
        const occ = occMap[p.name] ?? 0;
        occMap[p.name] = occ + 1;
        list.push({
          seq: ev.seq,
          name: p.name,
          occurrence: occ,
          input: p.input,
          result: p.result,
          effects: pendingEffects[p.name] ?? [],
        });
        delete pendingEffects[p.name];
      }
    }
    return list;
  }

  const parentSteps = extractSteps(parentEvents);
  const shadowSteps = extractSteps(shadowEvents);

  const diffItems: EffectDiffItem[] = [];

  for (const shadowStep of shadowSteps) {
    const parentMatch = parentSteps.find(
      (p) => p.name === shadowStep.name && p.occurrence === shadowStep.occurrence,
    );

    const forkedSeq = run.forked_from_seq ?? 0;
    const isReused = shadowStep.seq < forkedSeq;

    let inputChanged = false;
    if (parentMatch) {
      inputChanged = JSON.stringify(parentMatch.input) !== JSON.stringify(shadowStep.input);
    } else {
      inputChanged = true;
    }

    let status: EffectDiffItem["status"] = "live";
    if (isReused) {
      status = "reused";
    } else if (!parentMatch) {
      status = "added";
    } else if (inputChanged) {
      status = "modified";
    }

    diffItems.push({
      stepName: shadowStep.name,
      occurrence: shadowStep.occurrence,
      reusedFromParent: isReused,
      inputChangedFromParent: inputChanged,
      status,
      parent: parentMatch
        ? {
            seq: parentMatch.seq,
            input: parentMatch.input,
            result: parentMatch.result,
            effects: parentMatch.effects,
          }
        : null,
      shadow: {
        seq: shadowStep.seq,
        input: shadowStep.input,
        result: shadowStep.result,
        effects: shadowStep.effects,
      },
    });
  }

  return diffItems;
}

const RunsQuerySchema = z.object({
  status: z.enum(["running", "completed", "failed"]).optional(),
  mode: z.enum(["live", "shadow"]).optional(),
  limit: z.coerce.number().int().positive().optional(),
});

const ForkBodySchema = z
  .object({
    atSeq: z.number().int().positive({ message: "atSeq must be a positive integer" }),
    edit: z
      .object({
        input: z.unknown().optional(),
        result: z.unknown().optional(),
        mocks: z
          .union([
            z.record(z.string(), z.unknown()),
            z.array(
              z.object({
                stepName: z.string(),
                occurrence: z.number().int().nonnegative().optional(),
                result: z.unknown(),
              }),
            ),
          ])
          .optional(),
      })
      .optional(),
    mocks: z
      .union([
        z.record(z.string(), z.unknown()),
        z.array(
          z.object({
            stepName: z.string(),
            occurrence: z.number().int().nonnegative().optional(),
            result: z.unknown(),
          }),
        ),
      ])
      .optional(),
  })
  .refine((d) => d.edit !== undefined || d.mocks !== undefined, {
    message: "Must provide either 'edit' or 'mocks'",
  });

export function createApiApp(options: CreateApiOptions): Hono {
  const { engine, pool } = options;
  const configuredCorsOrigin = options.corsOrigin ?? "http://localhost:5173";
  const MAX_LIMIT = options.maxLimit ?? 50;
  const host = options.host ?? "127.0.0.1";
  const apiToken = options.apiToken ?? process.env.API_TOKEN;

  if (host !== "127.0.0.1") {
    console.warn(
      `[SECURITY WARNING] Binding API server to non-default host '${host}'. Ensure API is secured behind a trusted proxy or firewall.`,
    );
  }

  if (!isLoopback(host) && !apiToken) {
    throw new Error(
      `Refusing to start API server on non-loopback host '${host}' without API_TOKEN configured.`,
    );
  }

  const app = new Hono();

  // DNS Rebinding Protection: validate Host header for ALL routes
  app.use("*", async (c, next) => {
    const rawHost = c.req.header("host") || new URL(c.req.url).host;
    if (!rawHost || !isLoopback(rawHost)) {
      return c.json({ error: "Forbidden: invalid Host header (DNS rebinding protection)" }, 403);
    }
    await next();
  });

  // Strict CORS origin configuration: only configured origin is allowed
  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return null;
        if (origin === configuredCorsOrigin) {
          return configuredCorsOrigin;
        }
        return null;
      },
    }),
  );

  // Authentication middleware for mutating endpoints
  app.use("*", async (c, next) => {
    const isMutating = ["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method.toUpperCase());
    if (isMutating && apiToken) {
      const authHeader = c.req.header("Authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const token = authHeader.slice("Bearer ".length).trim();
      if (!safeCompareTokens(token, apiToken)) {
        return c.json({ error: "Unauthorized" }, 401);
      }
    }
    await next();
  });

  // Generic 500 error handler: never leak SQL text, internal schema, or stack traces
  app.onError((_err, c) => {
    return c.json(
      {
        error: "Internal server error",
      },
      500,
    );
  });

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  // POST /runs: Trigger a registered workflow
  const StartRunSchema = z.object({
    workflowType: z.string().min(1, "workflowType must be a non-empty string"),
    input: z.unknown().optional(),
  });

  app.post("/runs", async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parseResult = StartRunSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return c.json(
        {
          error: "Validation failed",
          issues: parseResult.error.issues,
        },
        400,
      );
    }

    const { workflowType, input } = parseResult.data;
    const registeredTypes = engine.getWorkflowTypes();
    if (!registeredTypes.includes(workflowType)) {
      return c.json(
        {
          error: `Unknown workflow type: '${workflowType}'. Registered workflow types: [${registeredTypes.join(", ")}]`,
        },
        400,
      );
    }

    const runId = await engine.startRun(workflowType, input);
    return c.json(redactApiOutput({ runId }), 201);
  });

  /**
   * 1. GET /runs
   * List runs with status, timing (derived from events), and mode.
   * Query validation with Zod. Limit capped at MAX_LIMIT (50).
   */
  app.get("/runs", async (c) => {
    const rawQuery = c.req.query();
    const parseResult = RunsQuerySchema.safeParse(rawQuery);
    if (!parseResult.success) {
      return c.json(
        {
          error: "Validation failed",
          issues: parseResult.error.issues,
        },
        400,
      );
    }

    const { status, mode, limit: requestedLimit } = parseResult.data;
    const limit = Math.min(requestedLimit ?? MAX_LIMIT, MAX_LIMIT);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status) {
      params.push(status);
      conditions.push(`r.status = $${params.length}`);
    }
    if (mode) {
      params.push(mode);
      conditions.push(`r.mode = $${params.length}`);
    }

    params.push(limit);
    const limitPlaceholder = `$${params.length}`;

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Calculate total count matching filters
    const countParams = conditions.length > 0 ? params.slice(0, conditions.length) : [];
    const { rows: countRows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM runs r ${whereClause}`,
      countParams,
    );
    const total = Number.parseInt(countRows[0]?.count ?? "0", 10);

    const { rows } = await pool.query<{
      id: string;
      workflow_type: string;
      status: string;
      mode: string;
      input: unknown;
      parent_run_id: string | null;
      forked_from_seq: number | null;
      fork_edit: unknown;
      created_at: Date;
      started_at: Date | null;
      completed_at: Date | null;
    }>(
      `SELECT 
         r.id,
         r.workflow_type,
         r.status,
         r.mode,
         r.input,
         r.parent_run_id,
         r.forked_from_seq,
         r.fork_edit,
         r.created_at,
         MIN(e.created_at) FILTER (WHERE e.type = 'RunStarted') as started_at,
         MAX(e.created_at) FILTER (WHERE e.type IN ('RunCompleted', 'RunFailed')) as completed_at
       FROM runs r
       LEFT JOIN events e ON r.id = e.run_id
       ${whereClause}
       GROUP BY r.id
       ORDER BY r.created_at DESC
       LIMIT ${limitPlaceholder}`,
      params,
    );

    const result = rows.map((row) => {
      const startedAt = row.started_at ?? row.created_at;
      const completedAt = row.completed_at;
      const durationMs = completedAt
        ? new Date(completedAt).getTime() - new Date(startedAt).getTime()
        : null;

      return {
        id: row.id,
        workflowType: row.workflow_type,
        status: row.status,
        mode: row.mode,
        input: row.input,
        parentRunId: row.parent_run_id,
        forkedFromSeq: row.forked_from_seq,
        forkEdit: row.fork_edit,
        timing: {
          createdAt: row.created_at,
          startedAt,
          completedAt,
          durationMs,
        },
      };
    });

    c.header("X-Total-Count", String(total));
    return c.json(redactApiOutput({ runs: result, total }));
  });

  /**
   * 2. GET /runs/:id
   * Full event log, current status, timing derived from events, and active task state.
   */
  app.get("/runs/:id", async (c) => {
    const id = c.req.param("id");

    const { rows: runRows } = await pool.query<{
      id: string;
      workflow_type: string;
      status: string;
      mode: string;
      input: unknown;
      parent_run_id: string | null;
      forked_from_seq: number | null;
      fork_edit: unknown;
      created_at: Date;
    }>(
      `SELECT id, workflow_type, status, mode, input, parent_run_id, forked_from_seq, fork_edit, created_at 
       FROM runs WHERE id = $1`,
      [id],
    );

    const run = runRows[0];
    if (!run) {
      return c.json({ error: `Run not found: ${id}` }, 404);
    }

    const events = await loadEvents(pool, id);

    const { rows: taskRows } = await pool.query<{
      id: string;
      run_id: string;
      step_key: string;
      attempt: number;
      status: string;
      run_at: Date;
      lease_owner: string | null;
      lease_expires_at: Date | null;
      last_heartbeat_at: Date | null;
    }>(
      `SELECT id, run_id, step_key, attempt, status, run_at, lease_owner, lease_expires_at, last_heartbeat_at
       FROM tasks WHERE run_id = $1 ORDER BY run_at ASC, id ASC`,
      [id],
    );

    const startedEvent = events.find((e) => e.type === "RunStarted");
    const lastResumedIdx = events.map((e) => e.type).lastIndexOf("RunResumed");
    const searchSlice = lastResumedIdx !== -1 ? events.slice(lastResumedIdx + 1) : events;
    const completedEvent = searchSlice.find(
      (e) => e.type === "RunCompleted" || e.type === "RunFailed",
    );

    const startedAt = startedEvent?.createdAt ?? run.created_at;
    const completedAt = completedEvent?.createdAt ?? null;
    const durationMs = completedAt
      ? new Date(completedAt).getTime() - new Date(startedAt).getTime()
      : null;
    const currentStatus = lastResumedIdx !== -1 && !completedEvent ? "running" : run.status;

    const responseData = {
      id: run.id,
      workflowType: run.workflow_type,
      status: currentStatus,
      mode: run.mode,
      input: run.input,
      parentRunId: run.parent_run_id,
      forkedFromSeq: run.forked_from_seq,
      forkEdit: run.fork_edit,
      timing: {
        createdAt: run.created_at,
        startedAt,
        completedAt,
        durationMs,
      },
      events: events.map((e) => ({
        seq: e.seq,
        type: e.type,
        payload: e.payload,
        createdAt: e.createdAt,
      })),
      tasks: taskRows.map((t) => ({
        id: t.id,
        runId: t.run_id,
        stepKey: t.step_key,
        attempt: t.attempt,
        status: t.status,
        runAt: t.run_at,
        leaseOwner: t.lease_owner,
        leaseExpiresAt: t.lease_expires_at,
        lastHeartbeatAt: t.last_heartbeat_at,
      })),
    };

    return c.json(redactApiOutput(responseData));
  });

  /**
   * 3. GET /runs/:id/effects
   * Diff view: original vs shadow effects, side-by-side with reusedFromParent and inputChangedFromParent.
   */
  app.get("/runs/:id/effects", async (c) => {
    const id = c.req.param("id");

    const { rows: runRows } = await pool.query<{
      id: string;
      workflow_type: string;
      status: string;
      mode: string;
      parent_run_id: string | null;
      forked_from_seq: number | null;
    }>(
      `SELECT id, workflow_type, status, mode, parent_run_id, forked_from_seq FROM runs WHERE id = $1`,
      [id],
    );

    const run = runRows[0];
    if (!run) {
      return c.json({ error: `Run not found: ${id}` }, 404);
    }

    const shadowEvents = await loadEvents(pool, id);
    let parentEvents: StoredEvent[] = [];
    if (run.parent_run_id) {
      parentEvents = await loadEvents(pool, run.parent_run_id);
    }

    const diffItems = buildEffectDiff(run, shadowEvents, parentEvents);

    const responseData = {
      runId: id,
      isFork: !!run.parent_run_id,
      parentRunId: run.parent_run_id,
      forkedFromSeq: run.forked_from_seq,
      mode: run.mode,
      steps: diffItems,
    };

    return c.json(redactApiOutput(responseData));
  });

  /**
   * 4. POST /runs/:id/fork
   * Fork at atSeq with edit and mocks. Validated with Zod.
   */
  app.post("/runs/:id/fork", async (c) => {
    const id = c.req.param("id");

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        { error: "Validation failed", issues: [{ message: "Invalid JSON body" }] },
        400,
      );
    }

    const parseResult = ForkBodySchema.safeParse(rawBody);
    if (!parseResult.success) {
      return c.json(
        {
          error: "Validation failed",
          issues: parseResult.error.issues,
        },
        400,
      );
    }

    const body = parseResult.data;

    const { rows: runRows } = await pool.query<{
      id: string;
      workflow_type: string;
      status: string;
      mode: string;
    }>(`SELECT id, workflow_type, status, mode FROM runs WHERE id = $1`, [id]);

    const run = runRows[0];
    if (!run) {
      return c.json({ error: `Run not found: ${id}` }, 404);
    }

    const warnings: string[] = [];
    if (run.mode === "shadow") {
      warnings.push("Parent run was already in shadow mode; created nested shadow fork.");
    }

    let editToPass: ForkEdit;
    if (body.edit && typeof body.edit === "object") {
      const mocks = (body.edit.mocks ?? body.mocks) as ForkMocksOption | undefined;
      if ("input" in body.edit && body.edit.input !== undefined) {
        editToPass = { input: body.edit.input, mocks };
      } else if ("result" in body.edit && body.edit.result !== undefined) {
        editToPass = { result: body.edit.result, mocks };
      } else if (mocks) {
        editToPass = { mocks };
      } else {
        return c.json(
          {
            error: "Validation failed",
            issues: [{ message: "Missing input, result, or mocks in edit" }],
          },
          400,
        );
      }
    } else if (body.mocks) {
      editToPass = { mocks: body.mocks as ForkMocksOption };
    } else {
      return c.json(
        { error: "Validation failed", issues: [{ message: "Missing edit or mocks" }] },
        400,
      );
    }

    if ("mocks" in editToPass && editToPass.mocks) {
      warnings.push("Mocks configured for shadow execution.");
    }
    if ("input" in editToPass) {
      warnings.push("Step input modified from parent run.");
    }
    if ("result" in editToPass) {
      warnings.push("Step result overridden from parent run.");
    }

    try {
      const forkedRunId = await engine.fork(id, body.atSeq, editToPass, {
        mocks: body.mocks as ForkMocksOption,
      });
      return c.json(
        redactApiOutput({
          runId: forkedRunId,
          warnings,
        }),
        201,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json(redactApiOutput({ error: message }), 400);
    }
  });

  /**
   * 5. POST /runs/:id/resume
   * Resumes failed or stalled run.
   * Serialized per runId via Postgres transaction-level advisory locks (pg_advisory_xact_lock)
   * to ensure simultaneous resume calls produce exactly 1 task & 1 execution, and no leaked locks.
   */
  app.post("/runs/:id/resume", async (c) => {
    const id = c.req.param("id");

    const client = await pool.connect();
    let shouldExecute = false;
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [id]);

      const { rows: runRows } = await client.query<{
        id: string;
        workflow_type: string;
        status: string;
        mode: string;
      }>(`SELECT id, workflow_type, status, mode FROM runs WHERE id = $1`, [id]);

      const run = runRows[0];
      if (!run) {
        await client.query("ROLLBACK");
        return c.json({ error: `Run not found: ${id}` }, 404);
      }

      if (run.status === "completed") {
        await client.query("COMMIT");
        return c.json(
          redactApiOutput({
            success: true,
            runId: id,
            status: "completed",
            message: "Run is already completed",
          }),
        );
      }

      if (run.status === "running") {
        await client.query("COMMIT");
        shouldExecute = false;
      } else {
        await reapTasks(
          client,
          undefined,
          engine.getWorkflowTypes().length > 0 ? engine.getWorkflowTypes() : undefined,
        );

        const currentEvents = await loadEvents(client, id);
        const last = currentEvents[currentEvents.length - 1];

        await appendEvent(client, id, {
          type: "RunResumed",
          payload: {
            fromSeq: last?.seq ?? 0,
            resumedAt: new Date().toISOString(),
          },
        });

        await client.query(`UPDATE runs SET status = 'running' WHERE id = $1`, [id]);
        await client.query(
          `UPDATE tasks SET status = 'pending', attempt = 0, run_at = now(), lease_owner = NULL, lease_expires_at = NULL WHERE run_id = $1 AND status != 'completed'`,
          [id],
        );

        await client.query("COMMIT");
        shouldExecute = true;
      }
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      const message = err instanceof Error ? err.message : String(err);
      return c.json(redactApiOutput({ error: message }), 500);
    } finally {
      client.release();
    }

    if (shouldExecute) {
      try {
        const outcome = await engine.execute(id, { resumeFailed: true });

        return c.json(
          redactApiOutput({
            success: outcome.status === "completed",
            runId: id,
            status: outcome.status,
            outcome,
          }),
        );
      } catch (err) {
        // If fencing error or conflict occurred, wait briefly for concurrent worker to finalize
        for (let i = 0; i < 20; i++) {
          const { rows: recheck } = await pool.query<{ status: string }>(
            `SELECT status FROM runs WHERE id = $1`,
            [id],
          );
          if (recheck[0]?.status === "completed") {
            return c.json(
              redactApiOutput({
                success: true,
                runId: id,
                status: "completed",
                message: "Run completed concurrently",
              }),
            );
          }
          await new Promise((r) => setTimeout(r, 25));
        }

        const message = err instanceof Error ? err.message : String(err);
        return c.json(redactApiOutput({ error: message }), 500);
      }
    } else {
      for (let i = 0; i < 40; i++) {
        const { rows: recheck } = await pool.query<{ status: string }>(
          `SELECT status FROM runs WHERE id = $1`,
          [id],
        );
        const currentStatus = recheck[0]?.status;
        if (currentStatus === "completed" || currentStatus === "failed") {
          return c.json(
            redactApiOutput({
              success: currentStatus === "completed",
              runId: id,
              status: currentStatus,
              message:
                currentStatus === "completed"
                  ? "Run completed concurrently"
                  : "Run failed concurrently",
            }),
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return c.json(
        redactApiOutput({
          success: false,
          runId: id,
          status: "running",
          message: "Run still in progress",
        }),
      );
    }
  });

  return app;
}
