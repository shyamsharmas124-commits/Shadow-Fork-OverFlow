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

### 4. At-Least-Once Delivery + Idempotency = Exactly-Once Effects
- If a worker crashes mid-task, the reaper (`reapTasks`) resets expired leases back to `pending`.
- Every step receives an auto-generated idempotency key:
  $$\text{idempotencyKey} = \text{sha256}(\text{runId} + ":" + \text{stepName} + ":" + \text{occurrence})$$
- Outbound HTTP connectors pass this key in the `Idempotency-Key` HTTP header. Downstream payment gateways and APIs deduplicate retry requests, ensuring exactly-once business effects despite at-least-once execution.

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
| **Effect Request Body** | `{"password": "secret", "note": "sk-..."}` | Sensitive keys -> `[REDACTED]`; string values scanned for Bearer, JWT, `sk-`, `ghp_`, `AKIA` | **Write-time** (connector -> `EffectCaptured`) |
| **Effect URL Userinfo** | `https://admin:secret@api.com` | Userinfo extracted and replaced with `https://[REDACTED]:[REDACTED]@api.com` | **Write-time** (connector -> `EffectCaptured`) |
| **Effect URL Path** | `https://api.com/keys/sk-...` | Value patterns (`sk-`, `ghp_`, `AKIA`, JWT) stripped from path strings via `redactStringValue` | **Write-time** (connector -> `EffectCaptured`) |
| **`StepCompleted.input`** | `{ "apiKey": "sk-..." }` | Cannot redact at write-time (would invalidate `inputHash`). Redacted recursively in API serializer. | **Read-time** (API layer) |
| **`StepCompleted.result`** | `{ "token": "ey..." }` | Cannot redact at write-time (downstream steps receive this result). Redacted recursively in API serializer. | **Read-time** (API layer) |
| **`StepFailed.error`** | `Failed: secret key sk-... rejected` | Exception string containing sensitive values. Redacted in API serializer. | **Read-time** (API layer) |
| **`EffectCaptured.wouldHaveResult`** | `{ "apiKey": "sk-..." }` | Reused or mocked return payload for the effect. Redacted in API serializer. | **Read-time** (API layer) |
| **`runs.input`** | `{ "webhookSecret": "..." }` | Workflow initial payload stored in `runs` row. Redacted in API serializer. | **Read-time** (API layer) |
| **`runs.fork_edit`** | `{ input: { "token": "..." }, mocks: [...] }` | Fork input override and mocks stored in `runs` row. Redacted in API serializer. | **Read-time** (API layer) |

> [!WARNING]
> Read-time redaction is best effort (field names and known credential value patterns); a secret stored under an ordinary field name (e.g. `{ "data": "supersecret" }`) can still reach API clients. The API must be treated as exposing whatever workflows store.

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

The architecture of `durable` draws directly upon foundational concepts in distributed systems and database research:

1. **Temporal / Cadence**:
   - *Temporal: Open Source Durable Execution Engine* ([temporal.io](https://temporal.io)).
   - We adopt Temporal's core paradigm of **event-sourced deterministic replay**: user code runs as ordinary TypeScript functions, with `ctx.step` recording inputs and outputs to an append-only log so that worker crashes are seamlessly resumed by replaying historical events.
   - We adopt Temporal's replay matching invariants: non-deterministic branching or modified step inputs raise `NonDeterminismError`, and virtual time and randomness primitives (`ctx.now`, `ctx.random`) replace ambient system calls.

2. **DBOS (Database-Oriented Operating System)**:
   - *Stonebraker, M., Cafarella, M., Kraska, T., et al. (2024). "DBOS: A Transformed Operating System for Cloud Applications." Proceedings of the CIDR 2024 Conference / VLDB.*
   - Rather than introducing a specialized distributed consensus cluster (like Raft or ZooKeeper), `durable` implements DBOS's thesis: modern ACID relational databases (specifically PostgreSQL) are exceptionally capable of managing workflow state, distributed leasing, task queues (`SKIP LOCKED`), and event logs directly.
   - Transactional isolation, row-level locks, and rollback semantics provide unyielding consistency with minimal operational overhead.
