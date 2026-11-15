# Tech Stack Scan Report: Shadow-Forking Durable Workflow Engine (Path A)

Prepared 15 November 2026. Scope: the durable workflow engine with Postgres leasing, event-sourced replay, and shadow forks (edit the input at event N, re-run forward with side effects captured instead of executed, then diff).

**How to read this report.** Everything here is a recommendation based on prior research in this project plus general knowledge up to mid-2026. I have not re-verified every version or project status for this report. Anything marked *verify* should be checked against official docs before you pin it or claim it in a README.

## 1. Executive summary

- The original stack (TypeScript, Node, Postgres, React + Vite + Tailwind) is still a sound default. Nothing newer beats it for a three-week, interview-grade project.
- The most useful newer ideas are not drop-in replacements. They are **different technologies that fit shadow forking specifically**: copy-on-write database branching, HTTP interception libraries, Effect-style typed side effects, and deterministic simulation testing.
- Biggest upgrade opportunity: **database branching** (Neon, Xata, PlanetScale-style) turns the hardest part of shadow forks, database side effects, from "roll back a transaction" into "run against a throwaway branch." Keep it as a v2 stretch; v1 uses transaction rollback.
- Biggest risk: queue bloat and lease contention with `SKIP LOCKED` under load, plus the effort of making the diff view trustworthy.

## 2. What Path A is, in one paragraph

A workflow runs through a context object (`ctx.step`, `ctx.now`, `ctx.random`, `ctx.sleep`). Every call is an append-only event. Replay re-runs workflow code against recorded events and throws `NonDeterminismError` on mismatch. A **shadow fork** copies events 1..N-1, edits event N, then continues live in *shadow mode*: each connector captures what it would have done (HTTP request, SQL effect) instead of doing it. The inspector shows a timeline, event detail, an edit-and-fork action, and a side-by-side diff of original vs fork including captured effects.

## 3. Current stack vs newer alternatives

This section lists **different technologies**, not newer versions of the same ones.

### 3.1 Runtime and language

| Layer | Current | Newer / different option | Verdict |
| --- | --- | --- | --- |
| Runtime | Node.js | Bun, Deno | Keep Node. Bun and Deno are fast and ship TypeScript natively, but worker processes, `pg` driver behavior and tooling are best-trodden on Node. Reconsider only if startup time matters. |
| Language | TypeScript | Rust, Go, Effect-TS (a TypeScript library, but a different programming model) | Keep TypeScript. Go or Rust makes the engine stronger but multiplies the work of SDK plus UI. |
| Typed effects | Plain async/await | **Effect-TS** | Worth a look: it models typed errors, retries, timeouts and resources natively, which maps to `ctx.step`. Cost: steep learning curve; risky for a 3-week plan. |

### 3.2 Storage and leasing

| Layer | Current | Newer / different option | Verdict |
| --- | --- | --- | --- |
| Event store | Postgres | SQLite/libSQL (Turso), FoundationDB, DuckDB (analytics only) | Keep Postgres. It gives you `FOR UPDATE SKIP LOCKED`, jsonb and real concurrency. SQLite is tempting for a one-file demo but weakens the multi-worker leasing story. |
| Task queue | Hand-rolled `tasks` table | pgmq, pg-boss, Graphile Worker, NATS JetStream, Redis/Valkey Streams | Keep hand-rolled. The leasing logic is your showpiece; using pg-boss would hide it. Study pgmq and Graphile Worker for design ideas. |
| DB for forks | Transaction rollback | **Copy-on-write branching: Neon, Xata, PlanetScale** | Best genuinely new technology for this project. A fork gets its own DB branch, so shadow mode for SQL effects becomes cheap and safe. Defer to v2. *Verify* current pricing, limits and branching API. |
| Migrations / queries | Raw SQL | Drizzle, Kysely | Plain SQL for lease logic. Kysely or Drizzle is fine for the inspector API only. |

### 3.3 Prior art and competing engines (study, do not adopt)

Temporal, DBOS, Restate, Inngest, Hatchet, Trigger.dev, Cloudflare Workflows and similar projects (*verify* which are current) all solve durable execution. Per the earlier scan, Temporal has *Reset* and DBOS has *fork from a step*. In the docs reviewed, neither clearly offered edit-input-at-event-N, side-effect-safe shadow forks, or a diff view. **Treat that as unverified until you re-check their current docs.** Restate and DBOS are the most useful to read for design ideas.

### 3.4 Side-effect capture (the core of shadow mode)

| Need | Option | Notes |
| --- | --- | --- |
| Intercept outgoing HTTP | **undici MockAgent / interceptors**, **MSW (Mock Service Worker)** in Node, nock | Undici is native to Node's `fetch`. MSW gives a clean request-handler API. Prefer interception at your own connector layer so you control the captured format. |
| Intercept Postgres | Transaction + rollback, record affected rows (v1); DB branch (v2) | Use savepoints for nested steps. |
| Fault injection / chaos | **Toxiproxy**, custom kill script | Good for the live worker-kill demo. |
| Idempotency | Per-run scoped keys | Keep as designed. |

### 3.5 Testing and reliability

| Layer | Current | Newer option | Verdict |
| --- | --- | --- | --- |
| Unit/integration | Ad hoc | **Vitest** + **Testcontainers** (real Postgres) | Adopt. |
| Property tests | None | **fast-check** | Adopt for replay determinism: random event histories must replay identically. |
| Deterministic simulation | None | FoundationDB/TigerBeetle-style simulation; Antithesis (commercial) | Stretch. A small seeded simulator with a fake clock and fake network, covering worker kills and lease expiry, is a very strong portfolio signal. |
| E2E UI | None | **Playwright** | Adopt for the fork flow. |

### 3.6 API and backend

| Layer | Current | Option | Verdict |
| --- | --- | --- | --- |
| HTTP framework | Unspecified | **Hono** (small, fast, portable) vs Fastify | Hono is a good fit. |
| Validation | Unspecified | **Zod**, Valibot, ArkType | Pick one for event payload schemas; schema-validated events make replay safer. |
| Typed client/API | Unspecified | tRPC, oRPC, ConnectRPC | Optional. Inspector talks to your own API only. |
| Observability | Logs | **OpenTelemetry** traces with `run_id` and `seq` as attributes | Adopt; replay timelines map naturally to traces. |

### 3.7 Inspector UI

| Layer | Current | Newer / different option | Verdict |
| --- | --- | --- | --- |
| Framework | React + Vite | SolidJS, Svelte 5, **TanStack Start/Router/Query** | Keep React for ecosystem reuse; add **TanStack Query** for run and event data. |
| Styling | Tailwind | Tailwind v4, **shadcn/ui** components | Adopt shadcn/ui to save time. |
| Timeline/graph | Custom | **React Flow (xyflow)**, visx, D3 | Use React Flow for the run graph; custom timeline for events. |
| Diff | Custom | **jsondiffpatch**, Monaco diff editor | Do not hand-build JSON diffing. Use jsondiffpatch for events and Monaco for payload text. |

### 3.8 Tooling

| Layer | Option | Verdict |
| --- | --- | --- |
| Lint/format | **Biome** or **Oxlint** | Biome for one-tool simplicity. |
| Build/bundling | Vite, **tsdown** (library builds) | Vite for UI; tsdown for the SDK package. |
| Monorepo | pnpm workspaces + Turborepo | Adopt pnpm workspaces; Turborepo optional. |
| Package manager | pnpm vs Bun | pnpm. |

### 3.9 AI layer for the demo workflow

| Need | Option | Notes |
| --- | --- | --- |
| LLM calls with structured output | **Vercel AI SDK**, Mastra, or the provider SDK directly | Use structured outputs so the extraction step returns schema-valid JSON. |
| Agent control surface | **MCP server** exposing `start`, `status`, `approve`, `fork` | Newer idea from the earlier scan. The MCP spec reportedly went stateless in July 2026 (*verify*). Good stretch goal. |
| Determinism for LLM steps | Record the LLM response as the step result | Forks that edit an LLM step's input must treat it as *effectful* (call live, or mock by default). |

## 4. Recommended stack for Path A

- **Core (keep):** TypeScript, Node (current LTS), Postgres (build on 18; move to 19 after its first patch, *verify* release status), hand-written SQL leasing.
- **Adopt now:** Vitest, Testcontainers, fast-check, Zod, Hono, OpenTelemetry, Biome, pnpm workspaces, TanStack Query, shadcn/ui, React Flow, jsondiffpatch, Playwright, undici interceptors or MSW.
- **Stretch (v2):** Neon/Xata database branching for SQL shadow forks, seeded deterministic simulation, MCP control surface, Effect-TS exploration.
- **Skip:** Bun/Deno switch, pg-boss or Temporal as the engine, Rust rewrite, SQLite as primary store.

## 5. Design changes this implies

1. **Connector interface.** Every effectful step goes through a connector with `live` and `shadow` modes. Shadow returns a recorded or synthetic result and writes a `captured_effects` event.
2. **Step classification.** Mark steps `pure`, `effectful-reversible` (SQL), or `effectful-external` (HTTP, email, payments). Forks default `external` to shadow.
3. **Fork API.** `POST /runs/:id/fork { atSeq, edit, mode }` creates a run with `parent_run_id` and `forked_from_seq`, copies events 1..N-1, writes the edited event N, and resumes.
4. **Captured-effect schema.** Add an `effects` table or event type: `run_id, seq, kind, request, would_have_result, mode`. The diff view is built from this.
5. **Divergence rule.** After the edited event, everything re-executes. Never replay recorded results past N.
6. **Hard question to settle early:** what does shadow mode return for an external call whose real result downstream code depends on? Options: reuse the original recorded result, a user-supplied mock, or a synthetic one. Pick reuse-original as the default and make it visible in the diff.

## 6. Revised milestones (about 3 weeks)

- **Days 1-3:** Schema, `appendEvent`, `ctx.step`, crash-and-resume test (Vitest + Testcontainers).
- **Days 4-6:** Leasing: claim query, heartbeats, reaper, fencing check, 3-worker kill test.
- **Days 7-9:** Retries with backoff and jitter, step timeouts, idempotency keys scoped per run.
- **Days 10-12:** Replay engine, `NonDeterminismError`, property tests with fast-check.
- **Days 13-15:** Fork API plus connector live/shadow modes; HTTP capture first, then Postgres rollback capture.
- **Days 16-19:** Inspector: timeline, event detail, edit-and-fork, then diff view built from captured effects.
- **Days 20-21:** Demo workflow (invoice or refund with LLM extraction and approval gate), chaos script, README with architecture diagrams, demo video.
- **Stretch:** DB branching, simulation tests, MCP tools.

## 7. Risks and mitigations

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| Queue bloat / dead tuples | Constant updates on `tasks` can bloat under load; this claim came from a competing project's README, so treat it cautiously | Tune autovacuum on `tasks`, archive finished rows, benchmark before claiming scale |
| Zombie workers | A slow worker can overwrite a reassigned task | Fencing: completion checks `lease_owner` (and consider an attempt counter) |
| Non-determinism | Code changes break replay | Version workflows; fail loudly with a clear diff of expected vs actual step |
| Shadow mode inaccuracy | Mocked results may mislead the diff | Label every captured effect with how its result was produced |
| Scope creep | Branching, MCP and simulation can swallow the schedule | Ship v1 with rollback-based capture only |
| Differentiator claims | "Others lack this" may be wrong | Re-read Temporal and DBOS docs before writing it anywhere |

## 8. Items to verify before pinning or publishing

1. Current Node LTS, TypeScript and PostgreSQL versions and release dates.
2. Current status, pricing and API of Neon, Xata and PlanetScale branching.
3. Whether Temporal, DBOS, Restate or others now offer edit-at-event forking or effect isolation.
4. MCP spec status and which SDK version supports it.
5. Maintenance status of Biome, Oxlint, MSW, and TanStack packages you pick.
6. Any claim in this report you plan to repeat in your README.

## 9. Bottom line

Keep the core stack and hand-written leasing. Add the newer tools that remove undifferentiated work (Testcontainers, fast-check, jsondiffpatch, React Flow, MSW/undici). Treat database branching as the one genuinely new technology that could make shadow forking much stronger, but keep it out of the first three weeks.
