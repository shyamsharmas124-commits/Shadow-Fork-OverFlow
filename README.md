# durable

An industrial-grade, Postgres-backed durable workflow engine in TypeScript featuring event-sourced deterministic replay, distributed leasing with fencing tokens, human-in-the-loop approval gates, and **Shadow Forking**: branch a workflow at event sequence *N*, re-execute forward with external side effects safely captured and database writes rolled back, and inspect side-by-side diffs before executing live.

---

## Architecture

```mermaid
flowchart TD
    subgraph Clients["Clients & Interfaces"]
        UI["Inspector Web Dashboard<br/>(React 19 + TanStack Query + xyflow)"]
        CLI["CLI & Scripts<br/>(pnpm demo / pnpm chaos)"]
        Ext["External Webhooks & Services"]
    end

    subgraph API["HTTP API Layer (@durable/api)"]
        Server["Hono REST API<br/>(127.0.0.1 Loopback Default)"]
        Auth["Constant-Time Token Auth<br/>(crypto.timingSafeEqual)"]
        RedactOut["Read-Time Redaction Serializer<br/>(redactApiOutput)"]
    end

    subgraph Engine["Core Workflow Engine (@durable/engine)"]
        Coordinator["Engine Coordinator<br/>(startRun, fork, submitApproval)"]
        ReplayEngine["Replay Engine & RunContext<br/>(step, waitForApproval, now, random)"]
        Guard["Egress Guard Interceptor<br/>(AsyncLocalStorage)"]

        subgraph ModeRouter["Connector Mode Router"]
            LiveConns["Live Connectors<br/>(LiveHttpConnector + LiveSqlConnector)"]
            ShadowConns["Shadow Connectors<br/>(ShadowHttpConnector + ShadowSqlConnector)"]
        end
    end

    subgraph Workers["Distributed Worker Fleet"]
        W1["Worker Process 1<br/>(OS Process / Pod)"]
        W2["Worker Process 2<br/>(OS Process / Pod)"]
        W3["Worker Process 3<br/>(OS Process / Pod)"]
    end

    subgraph Storage["PostgreSQL (ACID State Store)"]
        RunsTable[("runs Table<br/>(status, mode, parent_id, fork_edit)")]
        EventsTable[("events Table<br/>(Append-Only Trigger, PK: run_id, seq)")]
        TasksTable[("tasks Table<br/>(SKIP LOCKED, Leases, Fencing)")]
    end

    UI -->|"GET /runs, GET /runs/:id, GET /runs/:id/effects"| Server
    UI -->|"POST /runs/:id/approvals/:name"| Server
    CLI -->|"POST /runs, POST /runs/:id/fork, POST /runs/:id/resume"| Server

    Server --> Auth --> RedactOut
    Server --> Coordinator

    W1 & W2 & W3 -->|"claimTask() via FOR UPDATE SKIP LOCKED"| TasksTable
    W1 & W2 & W3 -->|"execute(runId)"| ReplayEngine

    ReplayEngine -->|"Load history (seq 1..N)"| EventsTable
    ReplayEngine --> ModeRouter

    LiveConns -->|"Real Network Outbound"| Ext
    ShadowConns -->|"Egress Blocked / Auto-Rollback SQL"| Guard

    ReplayEngine -->|"appendEvent(seq, type, payload)"| EventsTable
    ReplayEngine -->|"heartbeatTask() / completeTask()"| TasksTable
    Coordinator -->|"INSERT INTO runs / FOR UPDATE locks"| RunsTable
```

---

## Why durable?

Building reliable business processes across distributed microservices, LLM APIs, and third-party systems is notoriously difficult:
- Network requests time out, servers crash mid-mutation, and external webhooks deliver duplicates.
- Traditional job queues (BullMQ, Celery) lack deterministic replay: handling retries requires hand-crafted recovery logic for every single step.
- Orchestration giants like Temporal offer incredible power but introduce heavy architectural complexity (custom clusters, Cassandra/MySQL/Elasticsearch, proprietary gRPC protocols).

**durable** bridges this gap:
1. **Zero External Orchestrators**: Runs directly on **PostgreSQL**. Uses standard ACID transactions, row-level locks, and `FOR UPDATE SKIP LOCKED` for task dispatch and leasing.
2. **Deterministic Replay**: Steps record their inputs and outputs to an append-only event log. After a crash, completed steps return recorded results instantly without hitting network or database resources.
3. **Shadow Forking**: When a workflow is paused (e.g., at an approval gate) or fails, developers can fork execution at sequence *N* with modified inputs or mocked dependencies. The fork runs in **Shadow Mode**: external network egress is intercepted by an `AsyncLocalStorage` guard, SQL mutations run in an isolated transaction that automatically rolls back, and execution diffs are inspected side-by-side in the web UI.

---

## Core Guarantees

### 1. Durability & Immutability
- All workflow state transitions are recorded in the `events` table with a composite primary key `(run_id, seq)`.
- A PostgreSQL database trigger (`events_immutable`) forbids `UPDATE` and `DELETE` queries on the `events` table: history is permanently immutable and append-only.
- If two workers attempt to write to the same event sequence, the primary key constraint rejects the concurrent writer with `EventConflictError`.

### 2. Deterministic Replay
- When a workflow resumes, `ctx.step(name, fn, input)` checks the history cursor:
  1. If recorded, it compares the step name and the SHA-256 hash of `input`.
  2. If the name or input hash differs from history, the engine throws `NonDeterminismError`, specifying the exact event position.
- Non-deterministic primitives are recorded in the event log:
  - `ctx.now()` records the timestamp to `TimeRecorded` on first execution and replays the exact timestamp on replay.
  - `ctx.random()` records pseudorandom values to `RandomRecorded` and replays them deterministically.

### 3. Distributed Leasing & Fencing Tokens
- Multiple worker processes poll the `tasks` table using `SELECT ... FOR UPDATE SKIP LOCKED`.
- Workers claim tasks with an exclusive lease (`lease_duration_ms`).
- A background heartbeat timer (`heartbeatTask`) periodically extends `lease_expires_at`.
- When completing or failing a task, the worker verifies that its worker ID still matches `lease_owner`. If the lease expired and was claimed by another worker, the engine throws `FencingError`, preventing zombie workers from corrupting the run.

### 4. At-Least-Once External Delivery & Exactly-Once Event Log Recording
- The event log records each step completion (`StepCompleted`) exactly once; external network calls are at-least-once.
- If a worker crashes mid-task, the reaper (`reapTasks`) resets expired leases back to `pending`.
- Every step receives an auto-generated idempotency key derived via `makeIdempotencyKey(runId, stepKey, occurrence)`:
  $$\text{idempotencyKey} = \text{runId} + ":" + \text{stepName} + ":" + \text{occurrence}$$
  (implemented at `packages/engine/src/context.ts:96-98` and assigned at line 301).
- Outbound HTTP connectors pass this key in the `Idempotency-Key` HTTP header on external network calls.
- No test proves that external receivers deduplicate on Idempotency-Key; the engine only guarantees it sends the same key on a retry.
- **Deterministic Duplicate Window**: When a worker crashes (e.g. via SIGKILL) after dispatching an outbound network call but before committing `StepCompleted` to PostgreSQL, a replacement worker re-executes the step carrying the identical `Idempotency-Key`. An internal test-only hook (`__testHookBeforeStepCommit`) pauses execution between network response and database commit to verify this window deterministically; this hook is strictly gated behind `NODE_ENV === 'test'` and cannot be enabled in normal or production runs.

### 5. Human-in-the-Loop Approval Gates
- Workflows can request human intervention with `await ctx.waitForApproval(name, payload)`.
- Emits `ApprovalRequested` and parks the run in `running` status.
- **Queue Invariant**: While parked, the worker holds **0 leases** and the task queue contains **0 pending tasks**.
- Resumed via `engine.submitApproval(runId, name, { decision: "approve" | "reject", note })` or `POST /runs/:id/approvals/:name`.
- Submissions are row-locked and idempotent: concurrent submissions return the recorded decision.

### 6. Shadow Forking & Safety Boundaries
- Workflows can be forked at sequence *N* via `engine.fork(parentRunId, atSeq, edit, options)`.
- Copies events `1..N-1` into a new run with `mode = 'shadow'` and `parent_run_id`.
- **Shadow SQL Safety**: Reversible database steps execute on a dedicated PostgreSQL connection wrapped in `BEGIN`, with `SET LOCAL statement_timeout = 2000` and `SET LOCAL lock_timeout = 1000`. An AST parser validates the statement using `libpg-query`, rejecting multi-statement strings, transaction control (`COMMIT`, `ROLLBACK`), and dangerous administrative functions (`pg_advisory_lock`, `set_config`). The transaction is guaranteed to `ROLLBACK` in a `finally` block on completion, error, or timeout.
- **Egress Guard**: An `AsyncLocalStorage` guard intercepts `globalThis.fetch`, `http.request`, `http.get`, `https.request`, and `https.get`, raising `ShadowEgressError` on unauthorized network calls.
- **Side Effect Diffing**: The API derives execution diffs (`GET /runs/:id/effects`), classifying steps as `unchanged`, `modified`, `added-in-fork`, or `failed-in-parent`.

---

## Threat Model & Secret Redaction

External effect requests captured by shadow connectors are redacted at **write-time** before persistence to the `events` table. However, replay inputs and step results cannot be redacted at write-time without mutating input hashes and breaking deterministic replay guarantees; therefore, workflow inputs, step results, and error logs are redacted at **read-time** in the API layer before presentation to users.

| Location | Example Pattern | Redaction Strategy | Timing |
|---|---|---|---|
| **Effect Headers** | `Authorization: Bearer ...`, `Cookie: ...` | Sensitive key match (`[REDACTED]`) + regex scan for JWT, Bearer, and API keys | **Write-time** (connector -> `EffectCaptured`) |
| **Effect URL Query** | `?token=xyz`, `?apiKey=...` | Sensitive param names -> `[REDACTED]`; malformed query strings fail closed (`?[REDACTED]`) | **Write-time** (connector -> `EffectCaptured`) |
| **Effect Request Body** | `{"password": "secret", "note": "sk-..."}` | Sensitive keys -> `[REDACTED]`; string values scanned for Bearer, JWT, `sk-`, `ghp_`, `AKIA`, `tok_` | **Write-time** (connector -> `EffectCaptured`) |
| **Effect URL Userinfo** | `https://admin:secret@api.com` | Userinfo extracted and replaced with `https://[REDACTED]:[REDACTED]@api.com` | **Write-time** (connector -> `EffectCaptured`) |
| **Effect URL Path** | `https://api.com/keys/sk-...` | Value patterns (`sk-`, `ghp_`, `AKIA`, `tok_`, JWT) stripped from path strings via `redactStringValue` | **Write-time** (connector -> `EffectCaptured`) |
| **`StepCompleted.input`** | `{ "apiKey": "sk-..." }` | Cannot redact at write-time (would invalidate `inputHash`). Redacted recursively in API serializer. | **Read-time** (API layer) |
| **`StepCompleted.result`** | `{ "token": "ey..." }` | Cannot redact at write-time (downstream steps receive this result). Redacted recursively in API serializer. | **Read-time** (API layer) |
| **`StepFailed.error`** | `Failed: secret key sk-... rejected` | Exception string containing sensitive values. Redacted in API serializer. | **Read-time** (API layer) |
| **`EffectCaptured.wouldHaveResult`** | `{ "apiKey": "sk-..." }` | Reused or mocked return payload for the effect. Redacted in API serializer. | **Read-time** (API layer) |
| **`runs.input`** | `{ "webhookSecret": "..." }` | Workflow initial payload stored in `runs` row. Redacted in API serializer. | **Read-time** (API layer) |
| **`runs.fork_edit`** | `{ input: { "token": "..." }, mocks: [...] }` | Fork input override and mocks stored in `runs` row. Redacted in API serializer. | **Read-time** (API layer) |

> [!WARNING]
> Value-pattern redaction (including `tok_`, `sk-`, `ghp_`, `AKIA`, and JWT shapes) is best-effort and may over-redact identifiers matching those patterns. Read-time redaction is best effort (field names and known credential value patterns); a secret stored under an ordinary field name (e.g. `{ "data": "supersecret" }`) can still reach API clients. The API must be treated as exposing whatever workflows store.

---

## Claims & Verification Matrix

Every architectural and behavioral claim in this specification is backed by executable tests in the test suite:

| Section & Claim | Verifying Test / Evidence | Source File | Status |
|---|---|---|---|
| **1.1** State transitions recorded with PK `(run_id, seq)` | `rejects two concurrent writers appending the same seq` | `packages/engine/test/engine.test.ts:233` | Verified PASS |
| **1.2** Database trigger forbids `UPDATE` & `DELETE` on `events` | `is append-only (updates and deletes are rejected)` | `packages/engine/test/engine.test.ts:51` | Verified PASS |
| **1.3** PK conflict rejects concurrent writer with `EventConflictError` | `rejects two concurrent writers appending the same seq` | `packages/engine/test/engine.test.ts:233` | Verified PASS |
| **2.1** Replay validates step name and input SHA-256 hash | `detects same step name with different input` | `packages/engine/test/engine.test.ts:180` | Verified PASS |
| **2.2** Replay mismatches throw `NonDeterminismError` | `detects a changed step order mid-history` | `packages/engine/test/engine.test.ts:153` | Verified PASS |
| **2.3** `ctx.now()` & `ctx.random()` deterministically recorded and replayed | `records now() and random() so replay sees the same values` | `packages/engine/test/engine.test.ts:107` | Verified PASS |
| **2.4** Completed steps are returned from recorded history without re-executing the step function | `does not re-execute completed steps after a crash`<br/>`crash anywhere + resume == uninterrupted run` | `packages/engine/test/engine.test.ts:74`<br/>`packages/engine/test/replay.property.test.ts:73` | Verified PASS |
| **3.1** Atomic task claim via `FOR UPDATE SKIP LOCKED` | `claimTask atomically claims pending task with SKIP LOCKED` | `packages/engine/test/leasing.test.ts:32` | Verified PASS |
| **3.2** Exclusive worker leases (`lease_duration_ms`) | `claimTask atomically claims pending task with SKIP LOCKED` | `packages/engine/test/leasing.test.ts:32` | Verified PASS |
| **3.3** Heartbeat timer extends lease expiration | `heartbeat extends lease_expires_at` | `packages/engine/test/leasing.test.ts:50` | Verified PASS |
| **3.4** Fencing token rejects zombie worker completion | `fencing prevents a zombie worker from completing a reassigned task` | `packages/engine/test/leasing.test.ts:80` | Verified PASS |
| **4.1** Event log has one StepCompleted per step; external calls can repeat with the same key | `kills worker with SIGKILL during post-request / pre-commit window: counting server receives exactly 2 requests with identical Idempotency-Key and DB records exactly 1 StepCompleted` | `packages/engine/test/duplicate-window.test.ts:62` | Verified PASS |
| **4.2** Live HTTP connector request carries `Idempotency-Key` header | `live HTTP connector: request carries Idempotency-Key header received by server` | `packages/engine/test/shadow.test.ts:153` | Verified PASS |
| **4.3** Reaper resets expired leases to `pending` | `reaper returns expired running tasks to pending`<br/>`reaper reschedules task when lease expires while step is running` | `packages/engine/test/leasing.test.ts:65`<br/>`packages/engine/test/reliability.test.ts:373` | Verified PASS |
| **4.4** Auto-generated idempotency key (`${runId}:${stepKey}:${occurrence}`) | `idempotency keys are unique per run and differ between parent and fork`<br/>`pins idempotency key derivation: same run+step+occurrence gives the same key across a retry; different runs give different keys`<br/>`occurrence-indexed idempotency keys: two occurrences get different keys; retry of occurrence 1 keeps occurrence 1's key` | `packages/engine/test/fork.test.ts:452`<br/>`packages/engine/test/reliability.test.ts:370`<br/>`packages/engine/test/reliability.test.ts:424` | Verified PASS |
| **4.5** Outbound HTTP connectors pass `Idempotency-Key` header without redaction | `does not redact Idempotency-Key headers while redacting other sensitive headers` | `packages/engine/test/shadow.test.ts:1330` | Verified PASS |
| **5.1** `waitForApproval` parks run with status `running` | `1. park/resume: workflow requests approval, parks run without tasks, and resumes to completion on approval` | `packages/engine/test/approval.test.ts:84` | Verified PASS |
| **5.2** While parked: 0 leases held, 0 pending tasks | `1. park/resume: workflow requests approval, parks run without tasks, and resumes to completion on approval`<br/>`4. worker crash while parked: worker dies/reaps, run remains cleanly parked with 0 tasks picked up` | `packages/engine/test/approval.test.ts:84`<br/>`packages/engine/test/approval.test.ts:233` | Verified PASS |
| **5.3** Approval submission resumes parked workflow | `submits approval, records decision event, resumes execution, and returns 200` | `packages/api/test/api.test.ts:792` | Verified PASS |
| **5.4** Row-locked and idempotent approval submissions | `2. double approval idempotency: calling submitApproval twice appends exactly 1 event and returns 200`<br/>`2b. concurrent approval race: two simultaneous submitApproval calls serialize via row lock and append exactly 1 event` | `packages/engine/test/approval.test.ts:127`<br/>`packages/engine/test/approval.test.ts:156` | Verified PASS |
| **6.1** Fork copies history `1..N-1` into shadow run with parent link | `(a) parent events and runs row are identical before and after fork` | `packages/engine/test/fork.test.ts:40` | Verified PASS |
| **6.2** Shadow SQL execution bounded by `statement_timeout` & `lock_timeout` | `shadow SQL safety: lock_timeout fails fast when row lock is held, and non-transactional statements are rejected` | `packages/engine/test/shadow.test.ts:881` | Verified PASS |
| **6.3** AST parser rejects multi-statement strings, transaction control, & forbidden functions | `rejects 'COMMIT', leaves target rows unchanged, and surfaces clear error`<br/>`rejects 'set_config', leaves target rows unchanged, and surfaces clear error`<br/>`rejects 'pg_advisory_lock', leaves target rows unchanged, and surfaces clear error`<br/>`rejects 'SELECT \'a\\\'; COMMIT; --\'', leaves target rows unchanged, and surfaces clear error` | `packages/engine/test/shadow.test.ts:968`<br/>`packages/engine/test/shadow.test.ts:1008`<br/>`packages/engine/test/shadow.test.ts:1012`<br/>`packages/engine/test/shadow.test.ts:961` | Verified PASS |
| **6.4** Shadow SQL transaction rolls back in `finally` block | `SQL connector: shadow executes in transaction, records affected rows, and ROLLBACKs`<br/>`SQL connector: step that throws mid-query leaves no open transactions (pg_stat_activity) and rolls back` | `packages/engine/test/shadow.test.ts:221`<br/>`packages/engine/test/shadow.test.ts:279` | Verified PASS |
| **6.5** `AsyncLocalStorage` guard intercepts unauthorized network egress | `egress guard: shadow step calling raw fetch throws ShadowEgressError, 0 HTTP requests sent; live run unaffected`<br/>`egress guard catches direct https.get in shadow mode`<br/>`egress guard catches CommonJS require('node:http').request in shadow mode` | `packages/engine/test/shadow.test.ts:742`<br/>`packages/engine/test/shadow.test.ts:1290`<br/>`packages/engine/test/shadow.test.ts:1310` | Verified PASS |
| **6.6** Side effect diffing badges failed steps as `Failed in parent` | `labels step as 'Failed in parent' and displays redacted parent error when step failed in parent`<br/>`parent runs row, all events, and all tasks are byte-identical before and after fork through API` | `packages/ui/test/diff.test.tsx:50`<br/>`packages/api/test/api.test.ts:265` | Verified PASS |
| **7.1** Write-time redaction persists redacted effect in `EffectCaptured` | `write-time redaction persists redacted effect in EffectCaptured event` | `packages/engine/test/shadow.test.ts:1172` | Verified PASS |
| **7.2** Read-time redaction protects API outputs | `Location 1 (runs.input): planted secret appears in NO API response` through `Location 7 (EffectCaptured.request)` | `packages/api/test/api.test.ts:316-435` | Verified PASS |
| **8.1** Mutating endpoints require the bearer token; the code compares tokens with crypto.timingSafeEqual | `mutating endpoints require Authorization: Bearer <API_TOKEN> and reject missing/wrong token without side effects` (auth check)<br/>`packages/api/src/auth.ts:22-26` (`crypto.timingSafeEqual` implementation) | `packages/api/test/api.test.ts:468` | Verified PASS |
| **8.2** Host validation binds to loopback and prevents host header injection | `refuses to start on non-loopback host if API_TOKEN is unset`<br/>`isValidHost strictly matches configured host and port, rejecting mismatched ports and non-allowlisted loopbacks` | `packages/api/test/api.test.ts:449`<br/>`packages/api/test/api.test.ts:705` | Verified PASS |

---

## Quick Start

### 1. Installation & Migrations
```bash
# Install monorepo dependencies
pnpm install

# Configure PostgreSQL connection
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/durable

# Apply migrations (001_init.sql, 002_fork_edit.sql, 003_run_mode.sql)
pnpm --filter @durable/engine migrate
```

### 2. Run Test Suites
```bash
# Run all unit and integration tests across engine, api, demo, and ui
pnpm test

# Run Playwright end-to-end browser tests
pnpm --filter @durable/ui test:e2e
```

### 3. Run the Invoice Approval & Shadow Fork Demo
```bash
# Runs the full interactive business workflow demonstration
pnpm demo
```

### 4. Run the Multi-Process Worker Chaos Test
```bash
# Runs 10 concurrent workflows across 3 separate OS worker processes with mid-task SIGKILLs
pnpm chaos
```

### 5. Launch the Web Inspector Dashboard
```bash
# Terminal 1: Start API server on 127.0.0.1:3000
pnpm --filter @durable/api dev

# Terminal 2: Start Vite Inspector UI on localhost:5173
pnpm --filter @durable/ui dev
```
Open **http://localhost:5173** to inspect execution runs, event timelines, approval gate banners, and side-by-side shadow fork diffs.

---

## API Reference

| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| `GET` | `/health` | Health check endpoint | No |
| `GET` | `/runs` | List runs with status, timing, and mode filters | No (on loopback) |
| `POST` | `/runs` | Start a new workflow run | Yes (`Bearer <API_TOKEN>`) |
| `GET` | `/runs/:id` | Get run details, event stream, and active tasks | No (on loopback) |
| `POST` | `/runs/:id/fork` | Fork run at sequence *N* in shadow mode | Yes (`Bearer <API_TOKEN>`) |
| `POST` | `/runs/:id/resume` | Safely resume stalled or failed runs | Yes (`Bearer <API_TOKEN>`) |
| `POST` | `/runs/:id/approvals/:name` | Submit human approval decision (`approve`/`reject`) | Yes (`Bearer <API_TOKEN>`) |
| `GET` | `/runs/:id/effects` | Side-by-side diff between parent and shadow fork | No (on loopback) |

---

## Citations & Intellectual Heritage

The design and architecture of `durable` draw directly upon established paradigms in distributed systems and database research:

1. **Temporal / Cadence**:
   - Official Documentation: [Temporal Workflow Concepts](https://docs.temporal.io/workflows) (sections `#event-history`, `#replay`, `#deterministic-constraints`, fetched November 16, 2026).
   - **Deterministic Event-Sourced Replay**: A worker re-executes workflow definition code from the beginning, using [replay](https://docs.temporal.io/workflows#replay) against an append-only event history to rebuild in-memory state rather than restoring snapshots.
   - **Deterministic Constraints**: Workflow code must be deterministic so that replay generates identical command sequences; deviations trigger non-determinism errors (see [Deterministic Constraints](https://docs.temporal.io/workflows#deterministic-constraints)). Ambient side-effects and local clocks cannot be called directly inside workflow orchestration.

2. **DBOS (Database-Oriented Operating System)**:
   - Publication:
     - Qian Li, Peter Kraft, Kostis Kaffes, Athinagoras Skiadopoulos, Deeptaanshu Kumar, Jason Li, Michael Cafarella, Goetz Graefe, Jeremy Kepner, Christos Kozyrakis, Michael Stonebraker, Lalith Suresh, Matei Zaharia. *"A Progress Report on DBOS: A Database-oriented Operating System."* In *Proceedings of the Conference on Innovative Data Systems Research (CIDR)*, 2022. URL: http://cidrdb.org/cidr2022/papers/p13-li.pdf
   - Documentation: [DBOS Architecture & Durable Execution](https://docs.dbos.dev/) (fetched November 16, 2026).
   - **Postgres-Backed Durable Queues & Execution**: DBOS demonstrates executing workflows and durable queues directly on PostgreSQL using native concurrency control (such as row-level locking clauses), eliminating the need for a separate, heavyweight orchestration cluster.
