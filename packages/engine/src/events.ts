import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { EventConflictError } from "./errors.js";

export const EventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("RunStarted"),
    payload: z.object({ workflowType: z.string(), input: z.unknown() }),
  }),
  z.object({
    type: z.literal("StepCompleted"),
    payload: z.object({
      name: z.string(),
      inputHash: z.string(),
      input: z.unknown(),
      result: z.unknown(),
    }),
  }),
  z.object({
    type: z.literal("StepFailed"),
    payload: z.object({
      name: z.string(),
      inputHash: z.string(),
      input: z.unknown(),
      error: z.string(),
      attempt: z.number().optional(),
    }),
  }),
  z.object({ type: z.literal("TimeRecorded"), payload: z.object({ value: z.number() }) }),
  z.object({ type: z.literal("RandomRecorded"), payload: z.object({ value: z.number() }) }),
  z.object({
    type: z.literal("EffectCaptured"),
    payload: z.object({
      stepName: z.string(),
      kind: z.string(),
      request: z.unknown(),
      wouldHaveResult: z.unknown(),
      resultSource: z.enum(["original", "mock"]),
      attempt: z.number().optional(),
      reusedFromParent: z.boolean().optional(),
      inputChangedFromParent: z.boolean().optional(),
    }),
  }),
  z.object({ type: z.literal("RunCompleted"), payload: z.object({ result: z.unknown() }) }),
  z.object({ type: z.literal("RunFailed"), payload: z.object({ error: z.string() }) }),
  z.object({
    type: z.literal("RunResumed"),
    payload: z.object({ fromSeq: z.number(), resumedAt: z.string().optional() }),
  }),
]);

export type EventData = z.infer<typeof EventSchema>;
export type StoredEvent = EventData & { runId: string; seq: number; createdAt: Date };
type Db = Pool | PoolClient;

/** Appends the next event. The (run_id, seq) primary key makes concurrent writers fail loudly. */
export async function appendEvent(db: Db, runId: string, event: EventData): Promise<number> {
  const parsed = EventSchema.parse(event);
  try {
    const { rows } = await db.query<{ seq: number }>(
      `INSERT INTO events (run_id, seq, type, payload)
       SELECT $1::uuid, COALESCE(MAX(seq), 0) + 1, $2::text, $3::jsonb
       FROM events WHERE run_id = $1::uuid
       RETURNING seq`,
      [runId, parsed.type, JSON.stringify(parsed.payload)],
    );
    return rows[0]!.seq;
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new EventConflictError(runId);
    throw e;
  }
}

export async function loadEvents(db: Db, runId: string): Promise<StoredEvent[]> {
  const { rows } = await db.query(
    `SELECT run_id, seq, type, payload, created_at FROM events WHERE run_id = $1 ORDER BY seq`,
    [runId],
  );
  return rows.map(
    (r) =>
      ({
        ...EventSchema.parse({ type: r.type, payload: r.payload }),
        runId: r.run_id,
        seq: r.seq,
        createdAt: r.created_at,
      }) as StoredEvent,
  );
}
