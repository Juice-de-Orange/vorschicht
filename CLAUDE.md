# CLAUDE.md — Vorschicht

**Autonomous Claude Code orchestrator — build specification (public edition)**
Version 1.2 · 2026-09-30 · Language of this spec: English (project convention)

This is the specification the studio was built against, condensed for publication. The original
carried a 162-item engineering diary as Appendix A; the decisions that shaped the architecture now
live in `docs/adr/`, and Appendix A below is an index of them. Assumption numbers (`A12`, `A85`, …)
cited in code comments refer to that diary; the ones that still matter are listed at the end.

> **Status:** prototype. Phases 0–8 are built and tested; Phase 9 (pilot operation) has not started.
> The studio has never worked on a real writable project. See README "Status".

---

## 0. How to use this file (session protocol)

This file is the single source of truth for building Vorschicht. Every Claude Code session working on
this repo MUST follow these rules:

1. **Read first:** `CLAUDE.md` (this file), `README.md` and, if it exists, the build log `docs/STATE.md`
   (created by the build loop, see `docs/build-prompt.md`) before touching anything.
2. **Phase discipline:** work strictly phase by phase (§22). A phase is finished only when **every**
   exit-gate checkbox of that phase is ticked or deferred per A38. Tick checkboxes by editing this
   file and committing. Never weaken a gate to make it pass.
3. **Quality over speed.** Thoroughness beats velocity everywhere in this project.
4. **Questions to the operator:** always as multiple choice — 2–4 researched options with pros/cons
   and a recommendation, plus a free-text option. Written in **German** (language policy, §2).
5. **Assumptions:** if a small gap is found that this spec does not cover, decide according to the
   quality principle, implement it, and record it as an ADR in `docs/adr/` in the same commit.
   Critical gaps (security, data loss, agreed behaviour) → stop and ask.
6. **Session end:** update `CHANGELOG.md`, any affected docs and `.env.example`, tick completed gates
   here, commit with conventional commits. The next session must be able to continue with zero
   verbal handover.
7. **Never** write real credentials, hostnames or personal data into any file — use `.env`. Never
   push to remotes not configured for this project, never disable a baseline gate.

---

## 1. Mission & principles

**Vorschicht** ("the shift before yours") is an autonomous software studio: a 24/7 orchestrator that
plans, builds, reviews, tests, merges, deploys, researches and documents across the operator's
projects using a **Claude subscription via Claude Code** — and escalates only real decisions to the
operator, as prepared multiple-choice questions ("studio owner" model: every employee comes to the
owner with researched options).

Principles, in priority order:

1. **Quality is the headline.** Every output must be better than what a rushed human would produce.
2. **No half measures.** Every task ends in exactly one of three states: fully done (all gates green),
   cleanly parked (wrap-up protocol) or escalated with a prepared decision.
3. **Budget safety.** Never run into the 100 % subscription limit. Soft-stop at 85 % of **any**
   governing usage window (5-hour and weekly), hard ceiling at 95 % (the last 5 % is the operator's
   reserve).
4. **Full traceability.** goal → task → agent run → transcript → diff → gate results → merge → deploy.
5. **All findings are blockers.** There is no warning mode.
6. **Escalate, don't guess** on critical decisions — always with researched options.

---

## 2. System context

- **Host:** one Linux VPS with Docker Compose; an existing nginx on the host is the **only** public
  web entry (TLS terminated there, app bound to loopback). The dashboard is publicly reachable;
  WebAuthn passkeys, rate limiting and the audit log are the compensating controls (A1).
- **Push notifications:** a self-hosted (or hosted) ntfy server, token-protected topics.
- **Project folders** live on the host filesystem and are bind-mounted into the orchestrator
  container; they stay the single source of truth for development.
- **Git identity:** all agent commits are authored as `Vorschicht Bot <vorschicht-bot@example.com>`
  (configured in `.env`), never as a person. Bot tokens live in the same secret regime as the Claude
  auth token (A20).
- **Claude usage:** the operator's personal Claude subscription only. **Hard rule (v1): no API key,
  no usage credits, ever.** Claude Code is the only model access path; the `api-key` contingency
  backend (§6.0) is a designed seam only.
- **Billing reality:** Anthropic has announced, paused and promised to rework the billing of
  programmatic use (`claude -p`, Agent SDK). This is the project's **#1 external risk**; mitigations
  in §6.0. Usage credits / extra-usage overflow must be disabled or capped at 0 on the account.
- **Budget split:** 95 % of the subscription budget belongs to Vorschicht, 5 % is the operator's
  reserve — per window (5 h **and** weekly).
- **Language policy:** everything **user-facing is German** — dashboard UI, inbox cards, weekly report,
  ntfy messages. Agents work internally in English; code, commits, repo docs and this spec are
  English. (An English UI is a welcome contribution — see the issue tracker.)
- **Timezone** for scheduling and reports: `TZ` from `.env` (default Europe/Vienna).

---

## 3. Fixed tech stack

| Layer | Choice |
|---|---|
| Frontend | **Vite + React PWA** (TypeScript, installable, offline shell) |
| Backend/API | **Hono** (Node) serving REST + **SSE** for realtime, and the built PWA |
| Job queue | **pg-boss** (Postgres-backed queues, retries, cron) |
| Database | **PostgreSQL 16** + **Drizzle ORM** (migrations checked in, append-only triggers) |
| Auth | **Passkeys (WebAuthn)**, single operator |
| Runtime | One **Docker Compose stack** behind the host's nginx |
| Agent engine | **Claude Code CLI** in headless mode (`claude -p`), subscription auth, **version-pinned** |

Tooling (A4): Node 22 LTS, pnpm workspaces, TypeScript `strict`, Biome, Vitest, Playwright, Zod at every
boundary. **CLI pinning (A27):** the orchestrator image pins an exact CLI version; updates arrive as
radar tasks through the normal gates, never automatically.

### Repo layout

```
vorschicht/
  apps/web/          # Vite React PWA (German UI)
  apps/server/       # Hono API + SSE + static serving
  apps/orchestrator/ # daemon: scheduler, pg-boss workers, Claude Code runner
  packages/core/     # domain logic: tasks, gates, budget, merge queue, deploy, audit, model access layer
  packages/db/       # Drizzle schema + migrations
  packages/mcp/      # internal "vorschicht" MCP stdio server for agent sessions
  packages/shared/   # types, zod schemas, constants
  contracts/         # result-contract JSON schemas per role
  infra/             # compose, Dockerfiles, nginx template, systemd watchdog, gate + demo scripts
  docs/              # ADRs, OPERATIONS.md, ARCHITECTURE.md, DEVELOPMENT.md, DESIGN.md, sample audit reports
  e2e/               # Playwright specs against the real API
```

### Compose services

`db` (postgres:16, internal only) · `app` (Hono, exposes `127.0.0.1:8420`) · `orchestrator` (daemon +
workers + Claude Code CLI + git; mounts projects root rw, transcripts volume, claude auth volume) ·
`backup` (supercronic sidecar, §18). All services with healthchecks, restart `unless-stopped`,
resource limits. The host-level watchdog (§18.1) lives **outside** the stack as a systemd timer.

---

## 4. Architecture overview

```
                        ┌────────────────────────────────────────────┐
  operator (PWA)        │  nginx (host, TLS)                         │
  ──── passkey ───────▶ │   └─▶ app (Hono: REST + SSE + PWA)         │
                        │         │            ▲                     │
        ntfy push ◀─────┤         ▼            │ LISTEN/NOTIFY       │
        e-mail    ◀─────┤   PostgreSQL 16  ◀───┴──────────┐          │
                        │     ▲   ▲  (Drizzle, pg-boss,   │          │
                        │     │   │   append-only events) │          │
                        │     │   └──────────────┐        │          │
                        │  orchestrator daemon   │        │          │
                        │   ├ scheduler/cron ────┘        │          │
                        │   ├ budget guardian (usage meter)          │
                        │   ├ merge queue · deploy engine            │
                        │   ├ Betriebsprüfung (internal audit)       │
                        │   └ Claude Code runner ──▶ claude -p       │
                        │        │  (role profiles, --mcp-config)    │
                        │        ▼                                   │
                        │   /projects/* (git worktrees)              │
                        └────────────────────────────────────────────┘
```

Everything meaningful is appended to `event_log`; Postgres `NOTIFY` fans out to the server's SSE hub;
the PWA renders live. pg-boss carries all executable work. All model access flows through the
**model access layer** (§6.0) — no component ever calls `claude` outside it. A Mermaid version of
this diagram is in `docs/ARCHITECTURE.md`.

---

## 5. Data model

Design rule: **append-only / event-sourced wherever state history matters.** Mutable tables only for
pure configuration. Mandatory entities: `projects`, `goals`, `tasks` (a view over `task_events`,
A43), `task_events`, `agent_runs`, `claims`, `merge_queue`, `gate_runs`/`findings`, `deployments`,
`documents`/`document_versions`, `sources`, `escalations`/`decisions`, `usage_samples`/`usage_windows`,
`config`/`personas`, `audit_log`, `reports`, `audits`/`audit_findings`. The full column-level design
is in `packages/db/migrations/` with its reasoning in the migration comments.

---

## 6. Claude Code integration (the runner)

The orchestrator never talks to a model API directly. All model work goes through the **model
access layer**; its default backend spawns **Claude Code CLI headless sessions**.

### 6.0 Model access layer & billing resilience

- **`ModelBackend` interface** (`packages/core`): `spawn`, `resume`, `capabilities`, a usage/rate-limit
  event stream, kill/timeout semantics. Every caller depends only on this interface.
- **Backends:** `headless` (v1 default, `claude -p` on subscription auth) · `interactive-pty` and
  `api-key` (contingencies, shipped as typed stubs with a shared contract-test suite, A31) · `fake`
  (in-process, for the guardian tests, A37). Activating a contingency backend is an explicit
  operator decision, never automatic.
- **Billing watch:** the radar scans configured vendor pages for billing-model changes → **P0 inbox
  item**; the runner watches session results for signs of credit consumption → `hard_stop` + P0.
- **Sparbetrieb** (emergency low-budget profile, A22): one switch — concurrency 1, standard tier for
  all roles except the Reviewer, idle audits off, radar weekly.

### 6.1 Auth

`claude setup-token` on a trusted machine → long-lived OAuth token, stored **only** in the claude
auth volume, injected as `CLAUDE_CODE_OAUTH_TOKEN` (A5). Token age is monitored: warning at 30 days
remaining, P0 inbox item at 7 (A28). Any 401 is an **auth incident**, never a task failure: the
daemon idles, alerts, and parks affected tasks. A 1-turn smoke session must succeed before the
daemon accepts work.

### 6.2 Session spawning

```
claude -p "<task prompt>" --append-system-prompt "<role profile>" \
  --output-format stream-json --verbose --include-partial-messages \
  --allowedTools "<role tool whitelist>" --permission-mode acceptEdits \
  --max-turns <role cap> --model <role model alias> \
  --mcp-config <per-run document> --settings /app/claude/settings.<role>.json
```

Transport is `stream-json`; the final line is the result message. `--settings` injects the role's
containment hooks (§6.6). Dev-chain sessions run with `cwd` inside the task's git worktree; staff
sessions in per-role scratch dirs. Resume is scoped to the directory it started in, so the runner
persists `(session_id, cwd)`. Every run persists prompt, parsed result, session id, a copy of the
JSONL transcript, token usage, rate-limit snapshot, duration, exit status. Three independent run
caps: `maxTurns`, wall clock, and a kill on backend shutdown (A32).

### 6.3 Structured result contract

One JSON schema per role in `contracts/`, zod-validated by the runner:
`{ status: done | needs_decision | failed | parked, summary, artifacts[], followups[] }`.
How the contract reaches the pinned CLI is ADR 0002. Malformed result → one repair `--resume`; still
malformed → task red.

### 6.4 Escalation round-trip

The internal MCP tool `escalate.ask` creates the inbox item and the agent ends its turn with
`status: needs_decision`. The orchestrator parks the task (claims kept); after the operator answers,
the exact session is resumed from the same cwd with the decision injected. No context is lost.

### 6.5 Concurrency & models

Parallel sessions per plan profile (`max_20x` → 2, `max_5x` → 1; range 0–4, A7). Model mapping per
role via aliases (strongest tier for Planner, Reviewer, Legal, Security and the auditor; standard for
Coder and staff; economy for bulk chores, A8). No local models.

### 6.6 Containment, hooks & secret hygiene

Agents may **read across the projects root** but may **write only inside their own worktree and claim
set**. Enforced in layers: (1) `PreToolUse` hooks deny file-mutation tools outside worktree ∧ claims
**before execution**; (2) Bash is scoped per role whitelist; (3) the Reviewer verifies the diff stayed
inside the claim set. **Read hygiene** (A21): hooks deny reads matching secret patterns (`.env*`,
`*.pem`, `*.key`, `id_rsa*`, `credentials*`, …). **Transcript leak scan:** nightly gitleaks over new
transcripts → P0 escalation naming the secret class. Secrets never appear in prompts. The hook
protocol as measured against the pinned CLI is ADR 0004.

---

## 7. Controlling: usage meter & budget guardian

The most safety-critical component, built first (Phase 1).

**7.1 Usage meter** — primary source: the official rate-limit data the CLI surfaces (`used_percentage`,
`resets_at` per window; how it is captured is ADR 0001). Fallback and cross-check: a token-accounting
estimate (ADR 0005). Windows: 5 h, weekly-all, weekly per model class — **the tightest governing
window wins everywhere.** The dashboard shows a budget-confidence indicator with the data source.

**7.2 Guardian states**, identical on every window:

| State | Trigger | Behaviour |
|---|---|---|
| `normal` | < 85 % | full operation |
| `wrap_up` | ≥ 85 % | no new tasks start; running tasks execute the wrap-up protocol; no new deploys |
| `hard_stop` | ≥ 95 % | 60 s grace, then running sessions are terminated; tasks marked `interrupted` for an integrity re-check |
| reset | new window detected | parked/interrupted tasks resume **first**, in priority order |

Weekly policy is **greedy** (full utilisation, then rest until the reset, shown prominently in the
overview). Guardian state changes emit info notifications. A manual pause switch (A26) has the same
two semantics. **7.3 Wrap-up protocol:** finish the atomic step → `wip:` commit on the task branch →
handover note in `task_events` → keep claims, set `parked` → guardian confirms zero active sessions.

---

## 8. Departments & agent profiles

Each department is one or more **agent profiles**: role system prompt, tool whitelist, model tier,
triggers, output contract. Personas (names/avatars for the office view) are **display-only by
default** and can be switched off entirely; flavour text enters prompts only if enabled (A9).

| # | Department | Persona | Responsibilities |
|---|---|---|---|
| 1 | Produktleitung | Petra | goal intake, decomposition, prioritisation P0–P3 |
| 2 | Entwicklung | Paul (Planner), Clara & Chris (Coders), Rita (Reviewer) | the 3-chain Planner → Coder → Reviewer |
| 2a | Specialists | Dora (Debugger), Milo (DB/Migrations) | root cause of red tasks; migration review gate |
| 3 | QA/Testing | Quentin | test plans, regression suites, coverage watch |
| 4 | Security | Sasha | secrets-scan config, SAST, dependency audits |
| 5 | Legal/Compliance | Lena | GDPR checks, works from the vault + L5 sources with citations |
| 6 | Research/Radar | Rado | dependency, advisory, legal and **billing/CLI** radars |
| 7 | Doku & Archiv | Doris | docs gate, session-knowledge capture, vault curation |
| 8 | Ops/SRE | Otto | deploys, health, rollbacks, backups, disk |
| 9 | UX/A11y | Uli | axe scans, UX review of UI diffs |
| 10 | Controlling | Konrad | budget guardian, metering, weekly report |
| 11 | Betriebsprüfung | Bruno | audits the studio's claims about its own work (§8.2) |

**8.1 Dev chain:** Planner (plan, **file claim set**, test plan, subtasks) → Coder(s) (inside their
worktree, only claimed paths) → Reviewer (a different session; `approve` or `changes_requested`;
findings are blockers). Specialists are pulled in by the orchestrator on triggers.

### 8.2 Betriebsprüfung — the internal audit

Rita reads a diff and asks *is this correct*. Bruno reads the studio and asks *is what this system
says about itself true*. Every serious defect this project shipped and then caught belonged to one
class: the test encoded the same misunderstanding as the code, so a gate went green on a claim
nobody had tried to falsify. A studio that marks its own homework is structurally blind here.

**Audit programme** — one domain per run, rotating: (1) gate truth · (2) claim vs. evidence ·
(3) test substance · (4) assumption revision · (5) containment boundaries · (6) dead wiring ·
(7) process compliance · (8) number reconciliation. Sampling is randomised but **recorded**, and
every sample includes at least one item a previous audit passed.

**Method:** evidence before claim, always; a finding without evidence is a suspicion and blocks
nothing; finding nothing is a valid result; a dismissal is re-opened exactly once, a second dismissal
goes to the operator.

**Finding taxonomy:** `gate_invalid` (the gate **un-ticks itself** in this file with the reason, the
phase reopens, P1 inbox item) · `defect` (P1 fix task) · `process` (recorded + a task for a mechanical
guard) · `coverage_gap` (always a P2 task) · `assumption_expired` (inbox item) · `suspicion` ·
`scope_limit` (what could not be checked and why).

**Independence:** Bruno never writes (read-only tools, scratch cwd, never inside a project worktree);
strongest tier always, exempt from Sparbetrieb; no pause authority; and Bruno is audited (Controlling
tracks confirmed-vs-dismissed rate — a silent auditor and a working one look identical from outside).

**Cadence:** after every phase closes (an exit gate of its own) · weekly · before any self-deploy ·
after a rollback, a `hard_stop` or an auth incident · never as idle filler.

**The Prüfbericht** (German, hard length cap, archived, linked from every finding) ends with exactly
one verdict: `unbedenklich` · `funde_zu_beheben` · `phase_nicht_abschliessbar`. Sample reports are in
`docs/pruefberichte/`.

---

## 9. Task lifecycle

```
draft → queued → planning → claimed → coding → review → gates → merge_queue → merging → deploying → done
red path:  any failure → red → requeued (priority −1, learnings attached) → second failure → escalated
budget:    running → parked (wrap-up) → resumed
decision:  running → needs_decision → resumed with decision
```

Tasks waiting behind a parked task's claims display as *"blockiert durch Entscheidung #X"* with a deep
link. Every state change is one `task_events` row.

## 10. Parallel coding safety: file claims & merge queue

The Planner emits a claim set (path globs) per task; overlapping claims are **serialised** at
scheduling time (A45). Every coding task gets its own `git worktree` + branch `vorschicht/task-<id>`;
orphan GC runs daily (A44). **Merge queue** per project, strictly serialised: rebase onto latest `main`
→ full gate suite on the rebased tree → fast-forward merge → release claims → deploy engine. Any red
→ back to the task.

## 11. Gates system

**Baseline (locked, every project):** tests · typecheck · lint/format · secrets scan (gitleaks) ·
build · peer review. **Optional per project:** E2E, axe, Lighthouse budget, legal review, licence
compliance, SAST + audit threshold, migration review, docs gate, CHANGELOG gate. **Every finding is a
blocker.** Gate executions distinguish **findings** from **infra failures** (retry 3× with backoff,
never red, A25/A67). A gate-proposal agent proposes the set at onboarding; the operator confirms via
multiple choice. Vorschicht runs the same suite on itself (`pnpm gate`).

## 12. Deployment engine

After a green merge, deployment is **automatic with health check and auto-rollback**. Methods:
`compose` (image tagged with SHA → optional migrations → `up -d` → health), `static-rsync`
(`releases/<sha>` + atomic `current` symlink flip), `none`. Rollback on failed health → last
known-good → escalate (P0, or P1 when the rollback came back healthy, A133). Non-backward-compatible
migrations stop the deploy. No new deploys in `wrap_up`/`hard_stop`. **Self-deploy of Vorschicht
always requires explicit operator approval** (A12).

## 13. Document vault

Upload via dashboard; bytes on the docs volume, metadata + extracted text in Postgres with full-text
search; versions append-only. Department tags boost ranking for the requesting department. Agents
read via MCP `docs.search`/`docs.get`. Reference links flow into the source registry.

## 14. Source registry — five trust levels

L5 official/primary (laws, vendor docs) · L4 vendor docs & standards bodies · L3 reputable secondary ·
L2 community · L1 unverified. Curated sources are weighted reference works, not restrictions.
Departments may **propose** sources → inbox item. Legal outputs must cite ≥ L4.

## 15. Escalation inbox & decision memory

Inbox item (German): context in 3–5 sentences, origin, urgency, **2–4 researched options** with
pros/cons and a recommendation, free-text field, deep link. Answering resumes the parked session.
Decisions become **policy memory**: agents search prior decisions before escalating — the same
question is never asked twice. No escalation timeout: claims are held indefinitely and the
consequence is made visible. Reminders: ntfy immediately, e-mail after 24 h, daily digest (A13).

## 16. Notifications & weekly report

No quiet hours. ntfy topics `vorschicht-inbox` / `-alerts` / `-info`. E-mail via SMTP. **Weekly
report** Monday 07:00 (German, hard length cap): headline numbers · per project · quality trend ·
radar · Betriebsprüfung verdict · next week.

## 17. Dashboard PWA

Pages: overview (budget dial, active tasks, merge queue, inbox counter, banners), **office view**
(desks and avatars fed by SSE), projects, tasks & traces (full drill-down to the transcript line),
inbox, documents, sources, controlling (pause and Sparbetrieb switches), settings. One SSE stream
`/events` with reconnect and snapshot re-sync. Installable PWA with offline shell; push stays on ntfy.
The design system ("pixel office") is described in `docs/DESIGN.md`.

## 18. Logging, observability & backups

`event_log` and `task_events` are the source of truth and never deleted. Structured JSON logs with
correlation ids. Transcripts raw 90 days, then gzip 1 year (A15). Disk pressure: warning ≥ 80 %,
alert + prune of eligible artefacts ≥ 90 % (A30). Backups nightly: `pg_dump` + docs + transcripts →
`/backups`, then replicated to a backup host; retention 14 daily + 8 weekly; **a restore drill is a
Phase 9 gate.**

**18.1 Watchdog:** a host-level systemd timer every 2 minutes checks container health and the
orchestrator heartbeat; on failure → ntfy alert + **one** `docker compose start` attempt, then alert
only (A23). Accepted blind spot: if the host itself is down, no alert path exists.

## 19. Security

WebAuthn passkeys; **bootstrap requires two credentials** before registration locks; CLI rescue path
for a replacement credential. HttpOnly/Secure/SameSite=Strict sessions, rate-limited auth endpoints.
Only nginx reaches `app`; `db` and `orchestrator` have no published ports. Non-root containers,
read-only rootfs where possible, resource limits. Claude Code sessions run unprivileged inside the
orchestrator container with hook-enforced write/read policy (§6.6). `.env` on the host only;
gitleaks in the baseline gates and nightly over transcripts.

## 20. Project onboarding

Existing folder under the projects root, or a repo URL. An **onboarding agent** analyses the repo
(stack, commands, personal-data signals, deploy shape) and proposes gates, commands, claim
granularity and deploy config; the operator confirms via one multiple-choice escalation. Dry-run mode
(analysis without any write) is the default first step; a sample proposal is in
`docs/onboarding/example-app.md`.

## 21. Idle audits

When the queue is empty, the guardian is `normal` and usage < 50 % (A17): rotate the standing audit
programme across projects — Security, Robustness, Performance, Code quality, UX, Design, A11y, GDPR,
Testing, Ops. Findings become P2 tasks. Distinct from the Betriebsprüfung (§8.2), which examines
Vorschicht's claims about itself on a schedule idleness does not affect.

---

## 22. Phase plan — Phase 0 → done

Phases are strictly sequential; exit gates are ticked here in-file; **all** must be green (or deferred
per A38) before the next phase starts. "Demo" means a scripted, repeatable check
(`infra/scripts/demo-<phase>.sh` or a Vitest/Playwright spec), not a manual anecdote. Every ticked
or deferred gate ends with an evidence clause in `*(…)*`; `infra/scripts/gate-doku.mjs` holds the
tally below against `README.md` on every gate run.

Gate states: `[x]` green · `[~]` deferred to the target host with a scripted verification (A38) ·
`[ ]` open. Evidence clauses are condensed; the full audit trail is in the sample reports and ADRs.

---

### Phase 0 — Foundation & environment

Steps: monorepo + `pnpm gate` · compose skeleton with healthchecks · Drizzle + first migration ·
Claude CLI pinned in the orchestrator image with headless smoke test · git bot identity · nginx vhost
+ TLS · passkey auth with two-credential bootstrap and CLI rescue · watchdog timer · account
usage-credits checklist.

Exit gates — Phase 0:
- [x] `docker compose up -d` → all services healthy from a clean host checkout using only documented steps *(verified locally and on the production host, 2026-08-01)*
- [x] `pnpm gate` green locally and inside CI-equivalent container run *(clean `git archive` export in node:22-bookworm-slim; `infra/docker/Dockerfile.gate`)*
- [x] Headless `claude -p` round-trip (stream-json) succeeds **inside the container** on subscription auth at the pinned CLI version (no API key anywhere in the stack — verified by grep + gitleaks) *(authMethod oauth_token / apiProvider firstParty)*
- [x] Push to origin from inside the container succeeds authored as `Vorschicht Bot` via the bot token; token absent from repo and image layers (gitleaks + grep) *(verified 2026-08-01 from the orchestrator container: clone, empty commit, push to a scratch branch, branch deleted again; zero hits in the image layers)*
- [x] `https://<host>/healthz` green via nginx; TLS valid; **every guarded API route** answers 401 without a session, while the **auth ceremony under `/api/auth/`** and the **static shell** are deliberately public (§19) *(four route classes probed by `demo-phase0.sh`, incl. `/api/auth/state` → 200 without a session; un-ticked by audit 49c549b4 on 2026-08-18 because the sentence contradicted `app.test.ts:227`, fixed and re-ticked the same day, A141)*
- [x] Passkey bootstrap enforces two credentials before locking; register + login + logout demoed; further registration attempt correctly refused; CLI rescue generates a working one-time invite (demoed) *(6 Playwright specs via Chrome's virtual authenticator, `e2e/passkey.spec.ts`)*
- [x] Watchdog demo: killing the orchestrator container triggers an ntfy alert within ≤ 2 timer intervals (scripted) *(un-ticked by audit 67ac096c on 2026-08-02 — the script proved a syslog line, not a delivery; detection and **delivery** are now two journal lines, `curl -f` is evaluated, the topic comes from config; re-run on the host 2026-08-02 and again 2026-08-25 after the A102 rebuild, A156.2)*
- [x] `.env.example` complete; README quickstart reproduces the setup incl. the account-level usage-credits checklist; CHANGELOG current *(`demo-phase0.sh` G8 holds `.env.example` against the keys `loadConfig` reads; `gate:secrets` no longer excludes the file by path, A76.2)*

---

### Phase 1 — Spine: events, queue, runner, budget guardian

Steps: rate-limit capture spike (→ ADR 0001) · append-only `event_log` + NOTIFY → SSE · pg-boss job
taxonomy · model access layer + headless runner + contingency stubs · usage meter · budget guardian ·
auth incident path · minimal dashboard home.

Exit gates — Phase 1:
- [x] Official meter path demoed: `used_percentage` + `resets_at` captured from a real headless session and persisted; capture mechanism documented as ADR *(ADR 0001: neither the result message nor the transcript carries a percentage, only `control_request {get_usage}` does)*
- [x] Simulated usage streams (test fixtures) prove for **both** a 5h and a weekly window: no new task starts at ≥ 85%; all running work parked cleanly ≤ 95%; parked tasks resume first after window reset — as automated tests *(30 assertions, no real model call, via the `fake` backend A37)*
- [x] Wrap-up protocol demo: a long-running dummy task is parked mid-work with WIP commit + handover note, then resumes and completes *(`packages/core/src/wrap-up.itest.ts` against a real Postgres and a real git repository: interrupt rather than kill, `wip:` commit, handover note, park with claims kept)*
- [x] Runner chaos test: killing the orchestrator mid-session → restart → state reconciled, no orphan claims/sessions, task correctly `interrupted` and recovered *(`reconcile()` at daemon start closes every run without a `terminated` event and marks its task `interrupted`; the database refuses to move that task until the §7.2 integrity check passed; idempotent)*
- [x] Auth incident drill: invalid/expired token simulation → daemon idles + ntfy alert, **zero** tasks marked red, clean recovery after token replacement *(re-ticked 2026-08-01 after audit finding f5c42878: the loop body now lives in `apps/orchestrator/src/incident-cycle.ts` and is driven by `incident-cycle.test.ts`)*
- [x] Fallback meter numbers reconcile with raw JSONL on a real sample (spot audit script); divergence alert demoed with a skewed fixture *(divergence is raised as a Controlling anomaly rather than resolved silently; ADR 0005)*
- [x] SSE: reconnect + snapshot re-sync demoed; events appear < 1s locally *(catch-up by id; a 50 KB payload proven through the chain, since NOTIFY caps at 8000 bytes)*
- [x] All new tables append-only where specified; `pnpm gate` green; docs current *(six tables guarded against UPDATE, DELETE **and** TRUNCATE — the last needs a statement-level trigger)*

---

### Phase 2 — Dev chain & merge safety

Steps: agent profiles v1 · internal MCP server v1 · containment hooks (§6.6) · worktree manager ·
file claims · full Planner → Coder → Reviewer chain on the sandbox project · merge queue · red policy ·
**Betriebsprüfung v1** (§8.2) — built here rather than in Phase 6 because every later phase closes
under its audit.

Exit gates — Phase 2:
- [x] Demo: two parallel tasks with disjoint claims complete and merge cleanly in sequence through the queue *(`packages/core/src/merge-queue.itest.ts` against a real Postgres and two real git repositories; the second rebases onto the commit the first produced)*
- [x] Automated test: overlapping claims are detected and serialized — never concurrently active *(`packages/core/src/claim-registry.itest.ts`, 17 specs; `audit()` asserts §10's invariant after every case; per-project advisory lock proven)*
- [x] **Hook containment demo:** a seeded out-of-worktree write is denied pre-execution by the PreToolUse hook; a seeded `.env` read is denied by the read-hygiene hook — both scripted *(`infra/scripts/check-hook-containment.mjs`, one real session against the pinned CLI: 4 PreToolUse checks, 3 denials, one claimed write allowed; the load-bearing assertion is the filesystem afterwards; ADR 0004)*
- [x] Seeded-failure suite: an intentional test failure, a planted secret, and a lint error each individually block the merge; after fixes, merge succeeds *(each defect planted on the candidate branch, so the gate is a statement about the change; real `node --test`, the fixture's own lint and real gitleaks)*
- [x] Reviewer catches an out-of-claim edit (seeded, with hook deliberately bypassed via Bash) as a blocker — proving the second layer works independently *(`pnpm check:reviewer-claims` — one real Reviewer session over a two-file diff with a deliberately false Coder summary; verdict `changes_requested`)*
- [x] Red path demo: same task fails twice → correctly requeued once, then escalated with diagnosis attached *(`packages/core/src/dev-chain.itest.ts`: requeued at P2 with the learnings note, then `escalated` carrying the Debugger's root cause)*
- [x] All merge commits authored as `Vorschicht Bot`; no orphan worktrees/branches after the test suite (GC verified); `pnpm gate` green; docs current *(`foreignCommits()` over the real range — every commit the merge brings in is the bot's; re-ticked 2026-08-01 after audit finding 4419…)*
- [x] Betriebsprüfung (§8.2) run and its verdict recorded — scope covering Phases 0–2 retrospectively, since this is the first audit; every `gate_invalid` and `defect` finding fixed, or explicitly waived by the operator *(one real strongest-tier session, domain `gate_truth`, sample of six from the 23 ticked gates; verdict `phase_nicht_abschliessbar`: two `gate_invalid` findings un-ticked P1.G5 and P2.G7 through `AuditService`, in this file, unattended — both fixed and re-ticked)*

---

### Phase 3 — Gates system & onboarding

Steps: gate registry (locked baseline + optional catalogue) · gate runners incl. optional set ·
failure classification (A25) · findings pipeline · onboarding flow with dry-run · project settings
page.

Exit gates — Phase 3:
- [x] Dry-run onboarding of a real pilot repository produces a sensible, human-plausible proposal (gates, commands, claims, deploy shape) — reviewed by the operator via inbox-style MC *(closed 2026-08-18: the operator answered the proposal card and chose "adopt, keep analysing only"; a synthetic sample of the format is `docs/onboarding/example-app.md`)*
- [x] Every optional gate demonstrably blocks a seeded violation in the sandbox project and passes after fix *(all ten: six project commands settled in `packages/core/src/sandbox-gates.test.ts` with a real checker per class; the four in-process gates in their own suites; A66)*
- [x] Failure classification demo: a simulated registry/network outage retries with backoff and never marks the task red; a real test failure still does *(retry sits per **step** inside `GateSuite.run` (A67); five unit assertions pin the loop)*
- [x] Baseline gates verified non-removable via UI and API (attempt is refused + audit-logged) *(`project-service.itest.ts` for the rule and its audit row; `setGateConfig` reports a refusal by throwing; the UI half in `e2e/projekte.spec.ts`)*
- [x] Findings loop demo: gate red → fix task → green → merge, fully traced in the task timeline *(migration 0015: `gate_runs` append-only, `findings` a view over its red steps; the loop in `packages/core/src/findings-loop.itest.ts`)*
- [x] `pnpm gate` green; docs current *(re-ticked 2026-08-18 after audit 2150e493 un-ticked it: eleven of eleven steps in the container, numbers copied from the run)*
- [x] Betriebsprüfung (§8.2) run for this phase and its verdict recorded; every `gate_invalid` and `defect` finding fixed, or explicitly waived by the operator *(one real strongest-tier session, domain `gate_truth`, six gates from Phases 0–3 with three regression samples; verdict `funde_zu_beheben` — four findings, no `gate_invalid`, no `defect`)*

---

### Phase 4 — Escalation inbox & notifications

Steps: escalation model + policy memory · inbox UI (German) · `escalate.ask` round-trip · ntfy + SMTP ·
real producers wired.

Exit gates — Phase 4:
- [~] End-to-end demo on a real device: agent raises question → ntfy push arrives on the operator's phone → answer via PWA (MC option) → the same session resumes and completes using the decision *(deferred to the target host per A38 — it needs a physical phone; everything below the device is demonstrated in `packages/core/src/dev-chain.itest.ts` and `e2e/posteingang.spec.ts`)*
- [x] Free-text answer path demoed equally *(`nimmt eine reine Freitextantwort genauso an` in `dev-chain.itest.ts` — the German sentence arrives in the continuation verbatim; pinned from both sides in `escalation.test.ts`)*
- [x] Policy memory test: identical question the second time is auto-answered from precedent (with reference), no new inbox item *(`packages/core/src/agent-channel.itest.ts` against a real Postgres, all three clauses asserted separately)*
- [x] Inbox cards, MC options, and notification texts render in German (spot-checked against §2) *(the card in a browser against the real API in `e2e/posteingang.spec.ts`; the ntfy and mail texts in `notifications.test.ts`)*
- [x] A task waiting behind a parked task's claims displays "blockiert durch Entscheidung #X" with a working deep link; overview counter correct *(un-ticked by audit 767db82c on 2026-08-03 — the page rendered the parked task itself, not the one waiting **behind** it; fixed and re-proven in `e2e/ueberblick.spec.ts`)*
- [x] Reminder + digest verified with time-warp tests; e-mail renders correctly (HTML + plain) *(`packages/core/src/escalation-mail.itest.ts` against a real Postgres with an injected clock, a fresh database per case)*
- [x] Every decision appears in the decision log with full context linkage; `pnpm gate` green; docs current *(`e2e/posteingang.spec.ts` answers a card and reads the log entry back with question, answer, source and project)*
- [x] Betriebsprüfung (§8.2) run for this phase and its verdict recorded; every `gate_invalid` and `defect` finding fixed, or explicitly waived by the operator *(audit 67ac096c, `docs/pruefberichte/2026-08-02-67ac096c-gate_truth.md`: verdict `phase_nicht_abschliessbar`, one `gate_invalid` and two `defect` — all three in the watchdog, all fixed and re-proven on the host)*

---

### Phase 5 — Deployment engine

Steps: per-project deploy config · build + SHA tagging + release records · deploy job with health
polling · auto-rollback · guardian coupling · self-managed approval.

Exit gates — Phase 5:
- [x] Sandbox project (`compose`): green merge → automatic deploy → health green → release recorded, visible in UI *(`packages/core/src/merge-queue.itest.ts` drives real `MergeQueue`, `Scheduler` and `DeployService` over three ticks; the UI half in `e2e/projekte.spec.ts`)*
- [~] `static-rsync`: release dirs + atomic `current` flip verified; induced broken release (failing health) rolls back **by symlink flip** to last-good within the configured timeout and escalates P0 — demo scripted *(deferred to the target host per A38: only a real release host is missing; the target passes the same contract suite as `compose`, `infra/scripts/check-static-rsync.mjs` runs it against any host given on the command line)*
- [x] `compose`: induced broken release rolls back automatically to last-good SHA within timeout and escalates — P0, or P1 when the rollback itself came back healthy (§12, A133) — demo scripted *(against a real Docker daemon, `packages/core/src/deploy/compose.itest.ts`, ~41 s: good release → forced 503 → health fails → rollback → the URL answers the old release again)*
- [x] Migration order verified (migrate → swap → health) on a sandbox project; a seeded non-backward-compatible migration stops the deploy and escalates *(`compose.itest.ts` third run lets a real migration fail and then asks the health URL; the stop-and-escalate half in `service.itest.ts`)*
- [x] A project configured `deploy: none` ends its pipeline at merge with a correct terminal state *(`merge-queue.itest.ts` drives a task over three scheduler ticks with the real `DeployService` to `done`; the assertion is the absence of any deployment row)*
- [x] Deploy attempt during simulated wrap-up is correctly deferred and runs after reset *(`service.itest.ts` proves the deferral without side effects; `build-scheduler.itest.ts` drives the resume after the reset)*
- [x] Self-deploy without approval is refused; with approval it proceeds — both demoed *(`build-scheduler.itest.ts`: refused over **five** ticks, then approved via the inbox and deployed)*
- [x] Release history complete and consistent with git; `pnpm gate` green; docs current *(un-ticked by audit 767db82c on 2026-08-03 because "docs current" was claimed while the docs still said otherwise; fixed; release rows reconciled against `git log` in `deployments.itest.ts`)*
- [x] Betriebsprüfung (§8.2) run for this phase and its verdict recorded; every `gate_invalid` and `defect` finding fixed, or explicitly waived by the operator *(one real strongest-tier session, domain `gate_truth`, sample over all nine Phase-5 gates plus regression samples from 0–4; verdict `phase_nicht_abschliessbar`: six findings, two `gate_invalid`, no `defect`; all fixed)*

---

### Phase 6 — Full studio: departments, vault, sources, radar, idle audits

Steps: remaining department profiles · document vault · source registry · radar scans incl.
billing/CLI radar · idle-audit rotation · personas config · nightly transcript scan.

Exit gates — Phase 6:
- [x] Legal demo: a question about the statutes is answered by Lena using an uploaded statutes document + an L5 legal source, with citations and trust levels shown in the trace *(two real strongest-tier sessions on 2026-08-11 — a `finding` counter-case and the `green` carrying case — the assertion is that the two verdicts differ; `infra/scripts/check-legal-review.mjs`)*
- [~] Radar produces a real dependency proposal on a pilot repo: patch update becomes an auto-task that passes gates; a major update lands as an MC inbox item with researched options *(deferred to the target host per A38 — only a **writable** project is missing, and Vorschicht's own is `read_only` by decision (A85); the mechanism is proven in `packages/core/src/scans/radar/scan.itest.ts`)*
- [x] Billing/CLI radar demo: a seeded "billing change" fixture produces a P0 inbox item; a seeded CLI release lands as a normal radar task *(detection is a pure function over an input text; `billing.test.ts` and `cli-release.test.ts`)*
- [x] Transcript leak scan demo: a planted fake secret in a transcript triggers the P0 escalation naming the secret class *(against a real Postgres, real files and the **real** gitleaks — 27 cases in `transcript-leak.itest.ts`; one credential → exactly one P0 card carrying class and file)*
- [~] Idle audit run on a real project yields actionable findings filed as P2 tasks with correct traces *(deferred to the target host per A38 — same wall as P6.G2; §21 is built and holds 21 test cases in `idle-audit.test.ts`)*
- [x] Vault: upload → tag → agent retrieves it via MCP ranked by department tag — demoed *(60 test cases against a real Postgres and real files, plus 10 browser cases in `e2e/dokumente.spec.ts`)*
- [x] Persona A/B check: identical task with personas on (display-only) vs fully off produces equivalent-quality results (spot comparison documented) — personas verifiably cost nothing *(67 test cases; with flavour off `systemPromptAppend` is byte-identical to `profile.systemPrompt` for every profile; the documented A/B run is `docs/personas-ab-vergleich.md`)*
- [x] `pnpm gate` green; docs current *(second attempt: the first tick was un-ticked by audit f785a443 on 2026-08-11 because the docs lagged; twelve of twelve steps green in the container)*
- [x] Betriebsprüfung (§8.2) run for this phase and its verdict recorded; every `gate_invalid` and `defect` finding fixed, or explicitly waived by the operator *(one real strongest-tier session, domain `gate_truth`, sample over the nine exit gates of this phase plus regression samples from 0–5; verdict `phase_nicht_abschliessbar`: three findings, one `gate_invalid`, no `defect`; all fixed)*

---

### Phase 7 — Dashboard PWA complete (incl. office view)

Steps: overview home final · office view · task/trace explorer with transcript viewer · remaining
pages · PWA finalisation, a11y pass, German copy pass.

Exit gates — Phase 7:
- [x] Office view reflects real state changes < 1s end-to-end (measured), including park/resume and escalation states *(measured from the write into `task_events` to the bubble at the desk — NOTIFY, SSE, render — by polling `data-kugel` every 10 ms in `e2e/buero.spec.ts`)*
- [x] Cold load of the overview < 2s over a throttled mobile profile against the VPS (measured, documented) *(1 856 ms in the worst of six runs on 2026-08-18 against the production host, limit 2 000; LCP in the mobile profile 412×823@1.75, 1 638.4 kbit/s, 150 ms RTT; `infra/scripts/kaltstart-messung.mjs`)*
- [x] Lighthouse: PWA installable pass; performance budget met (budget documented in repo) *(median of three throttled mobile runs: performance 96, LCP 1 956 ms, TBT 66 ms, CLS 0.061; budget in `infra/leistungsbudget.json`, rationale in `docs/leistungsbudget.md`, drift check `check-leistungsbudget.mjs`)*
- [x] axe scan on all pages: zero violations (own medicine) *(twelve pages, zero violations each at 23–36 applied rules, 14 browser cases in the `a11y` project of `e2e/zugaenglichkeit.spec.ts`)*
- [x] Full drill-down demo: from a dot in the office view to the exact transcript line of a decision in ≤ 4 clicks *(3 clicks of 4 allowed: desk → open task → jump to the decision in the session log; 12 browser cases in the `traces` project, clicks **counted** by a listener)*
- [x] Pause switch demo: pause parks running work cleanly and blocks new sessions; resume returns to normal — audit-logged *(`infra/scripts/check-pause.mjs`, 13 green · 0 red against a real Postgres with the real wiring; the UI half in `e2e/controlling.spec.ts`)*
- [x] Operator sign-off on design, German UI copy & overview via an inbox item; `pnpm gate` green; docs current *(answered "Abgenommen" on 2026-08-18 — card #16, source `design_signoff`, from a registered passkey session, A137)*
- [x] Betriebsprüfung (§8.2) run for this phase and its verdict recorded; every `gate_invalid` and `defect` finding fixed, or explicitly waived by the operator *(audit 49c549b4 in the gate image on the host, `docs/pruefberichte/2026-08-18-49c549b4-gate_truth.md`, against the candidate rather than the deployed tree; its `gate_invalid` on P0.G5 fixed the same day, A141)*

---

### Phase 8 — Controlling analytics & weekly report

Steps: metrics aggregation jobs · weekly report generator with schedule and archive page ·
Controlling page final.

Exit gates — Phase 8:
- [~] Report generated from real operational data matches the structure spec exactly, is written in German, and renders in common mail clients (HTML + plain verified) *(deferred to the target host per A38 — only a real mail account is missing; the six sections in spec order, German, HTML **and** plain text are asserted in `report.test.ts`; the first real report was generated from production data on 2026-08-18)*
- [x] Spot audit: every headline number reconciles with the event log via an audit script *(un-ticked by audit 52a68316 on 2026-08-25 because the script reconciled five of eight numbers; `infra/scripts/check-kennzahlen.mjs` now recomputes all eight independently, `kennzahlen-remote.sh` runs it against a live database)*
- [x] Length cap enforced (test with padded data); zero filler sections *(the cap is tested against **padded** data; every cut is written out rather than made silently; `report-length.test.ts`)*
- [x] Schedule fires correctly in Europe/Vienna incl. DST test; archive shows history; `pnpm gate` green; docs current *(four cases across both DST transitions in `report-schedule.test.ts`; the archive page in `e2e/berichte.spec.ts`)*
- [x] Betriebsprüfung (§8.2) run for this phase and its verdict recorded; every `gate_invalid` and `defect` finding fixed, or explicitly waived by the operator *(two real strongest-tier sessions on 2026-08-25; the second, `2969f99f`, against the candidate: `funde_zu_beheben`, no `gate_invalid`; the first, `52a68316`, is in `docs/pruefberichte/`)*

---

### Phase 9 — Pilot operation & hardening (→ "done")

Steps: onboard three pilot projects · supervised operation ≥ 2 weeks · tuning from live data ·
operations guide (`docs/OPERATIONS.md`) · backup restore drill and rollback drill · final acceptance.

Exit gates — Phase 9:
- [ ] ≥ 2 consecutive weeks of operation with **zero uncontrolled limit events** (never reached 100% on any window; every threshold crossing handled by the guardian as specified)
- [ ] ≥ 15 real tasks across the 3 pilots merged with all gates green and auto-deployed *(A19: count is the acceptance floor, adjustable)*
- [ ] Red path exercised in the wild at least once and resolved per policy (trace reviewed)
- [ ] Restore drill passed: yesterday's backup (incl. transcripts) restored and verified consistent in scratch
- [ ] Rollback drill passed on a pilot project in production conditions
- [ ] Operations guide complete; a cold restart of the host brings the whole stack back healthy without manual fixes, watchdog re-arms (tested)
- [ ] Weekly reports of the pilot weeks judged useful by the operator (no info garbage)
- [ ] Final Betriebsprüfung (§8.2) across all nine phases — every domain covered at least once, every deferred gate of A38 re-examined against its host run — closing on `unbedenklich`, or with every open finding explicitly waived in writing
- [ ] Final acceptance: the operator approves via inbox item "Vorschicht v1.0 accepted"

---

## 23. Global Definition of Done (every task, every phase)

Code typechecked · tested (coverage not decreased) · linted/formatted · secrets-clean · peer-reviewed ·
built · documented (READMEs/docs/`.env.example` current) · CHANGELOG entry · no unexplained TODO/FIXME ·
migrations reversible or explicitly documented · demoed via a scripted, repeatable check · fully
traced in the event log.

---

## Appendix A — Assumptions (index)

The decisions taken while building, by their original number, one line each. The reasoning, the
measurements and the consequences are in the ADR each line points to; `packages/core/src/audit/gate-book.ts`
reads this list for the audit's "assumption revision" domain.

- **A1 — The dashboard is public.** One public hostname behind the host's nginx, app bound to loopback, passkeys + rate limiting + audit log as the compensating controls; no Web Push API, ntfy covers push. → ADR 0006
- **A5 — Subscription auth only.** `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` in a persistent volume; a startup smoke check gates the daemon; token age is monitored (A28). → ADR 0007
- **A7 — Concurrency follows the plan profile.** `max_20x` → 2 parallel sessions, `max_5x` → 1; range 0–4. → ADR 0008
- **A9 — Personas are display-only by default.** Prompt flavour is opt-in and byte-identical off; a full off switch exists. → ADR 0009
- **A12 — Self-deploy needs approval every time.** An autonomous system must not hot-swap its own brain unsupervised. → ADR 0010
- **A21 — Read hygiene is a hook.** Secret-file patterns are denied at `PreToolUse`; a nightly gitleaks run over new transcripts raises a P0 naming the secret class. → ADR 0011
- **A22 — Sparbetrieb is one switch.** Concurrency 1, standard tier except the Reviewer, idle audits off, radar weekly; the auditor's tier never drops. → ADR 0008
- **A23 — The watchdog lives outside the stack.** A systemd timer every 2 min; one restart attempt, then alert only. → ADR 0012
- **A25 — Findings and infra failures are different colours.** Infra retries 3× with backoff and never counts as red; exit 1 = finding, 2 = infra (A50), retried per step (A67). → ADR 0013
- **A27 — The CLI is pinned.** An exact version in the image; updates only as radar tasks through the gates. → ADR 0014
- **A31 — Contingency backends ship as typed stubs.** `interactive-pty` and `api-key` implement the full contract and fail fast; a `fake` backend (A37) carries the guardian tests. → ADR 0015
- **A32 — Run caps are enforced by the backend, never by a flag alone.** `maxTurns`, wall clock and shutdown kill are three independent caps. → ADR 0014
- **A38 — A gate may be deferred to the target host.** `[~]` means the only blocker is an artefact of the host or a physical action, and a scripted verification exists. → ADR 0016
- **A41 — Onboarding is dry-run first.** The agent reads and proposes; applying is a separate act on a proposal that was verified. → ADR 0017
- **A42 — The studio is its own pilot.** Vorschicht is onboarded as a `selfManaged` project and stays `read_only` (A85) until a writable clone exists. → ADR 0017
- **A43 — A task is its event stream.** `tasks` is a view over `task_events`; claims carry one invariant (A45): two active tasks never overlap in a project. → ADR 0018
- **A52 — The internal audit exists because self-testing is structurally blind.** Four shipped defects had passed their own tests; only a different party asking a different question found them. → ADR 0019
- **A56 — The audit's report is the durable record.** A database row does not survive a manual run (A92); `scope_limit` reports what could not be checked and a `coverage_gap` always creates a task (A65). → ADR 0020
- **A61 — Integration tests never skip silently.** `*.itest.ts` need `TEST_DATABASE_URL`; the gate provides it, and the gate itself runs in a Linux container (A127) — `infra/docker/Dockerfile.gate` is the orchestrator image's sibling. → ADR 0022
- **A73 — The rate-limit frame carries the real figure only above the warning threshold.** Below it the guardian relies on the estimate (ADR 0005). → ADR 0023
- **A76 — An evidence line is invisible to every test.** Only a human and the auditor read it, so the auditor samples it. → ADR 0024
- **A101 — A guardian latch that never clears is fail-forever.** The latch is cleared on every fresh estimate; anomalies are rate-limited. → ADR 0023
- **A117 — A real audit needs a persistent database.** No throwaway Postgres for an audit run; its report must survive (A92). → ADR 0021
- **A134 — Documentation is held against the spec by a script.** `gate-doku.mjs` counts the gates in this file and fails the gate when README or the docs claim otherwise (A152). → ADR 0025
