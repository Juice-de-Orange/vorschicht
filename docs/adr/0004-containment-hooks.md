# ADR 0004 — The containment hook answers in JSON, and the session it guards did not know how to end

- **Status:** accepted
- **Date:** 2026-08-01
- **Context:** §6.6, §6.2, A21, A32, Phase 2 step 4
- **Evidence:** four probes against CLI **2.1.220** (the pinned version). Two cost
  nothing — a `SessionStart` hook fires before the model is consulted, so the
  probe reads one line and kills the session. Two were `haiku` sessions, needed
  because a `PreToolUse` hook only fires when an agent reaches for a tool.
  Combined cost of every probe and the finished gate demo: **≈ 0.07 USD**.

## The questions

§6.6 prescribes `PreToolUse` hooks that deny a write outside the worktree ∧
claim set and deny a read of a credential. Between that sentence and a refusal
sit five mechanisms the spec does not describe and each of which fails silently.

## What we found

### 1. The hook command runs through a shell, and inherits the session's environment

A `SessionStart` hook registered as `node …/recorder.mjs sessionstart
$VORSCHICHT_PROBE` received `probe-value-42` **both** as an expanded argument and
in `process.env`. So a variable set on the `claude` process reaches the hook —
which is what lets `VORSCHICHT_RUN_POLICY` name this run's containment document
while the `--settings` file stays per role and knows nothing about any
particular run.

Two consequences taken:

- The hook reads the variable from `process.env`, not from its argv, so no
  quoting scheme sits between the policy path and the process that needs it.
- `buildRoleSettings` **refuses** a hook path containing whitespace or a shell
  metacharacter. A split command line is a hook that never runs, silently.

### 2. `CLAUDE_CODE_OAUTH_TOKEN` is not in the hook's environment

Observed directly: the recorder reported the variable absent while every other
inherited variable was present. The CLI strips its own credential before running
hook commands. Recorded because it is a property we now rely on rather than one
we arranged, and because the opposite assumption would have led to defensive
blanking we do not need.

### 3. Both denial mechanisms work, and only one of them keeps a refusal distinguishable from a fault

One session, two tools, two mechanisms:

| how the hook answers | tool | CLI outcome | what the model was shown |
|---|---|---|---|
| JSON `permissionDecision: "deny"` on stdout, exit 0 | `Write` | `success`, exit 0 | our reason, verbatim |
| exit 2 with a message on stderr | `Read` | `error`, exit 2 | `PreToolUse:Read hook error: [node …]: <stderr>` |

Both blocked the tool and both appeared in `permission_denials[]` on the result
message.

**Every decision is therefore reported as JSON with exit 0.** Not for the
tidier message — for the outcome field. With exit 2, "the hook refused" and "the
hook crashed" are the same event in the stream, and those two need opposite
responses: the first is the system working, the second is a run that must be
retried as an infra failure (§11, A25). With the JSON form, `outcome: "error"`
means one thing only, and `ContainmentMonitor` acts on it.

The corollary is the hard rule in `hook-entry.ts`: **it must never exit 1.** Any
other non-zero code is a non-blocking error and the tool *proceeds* — so an
uncaught exception in Node would let through exactly the write it was spawned to
stop. Every path is wrapped, and `uncaughtException` / `unhandledRejection`
handlers deny and exit 0 rather than let the process die naturally.

`SessionStart` is the one place exit 2 is used, and there it means the opposite:
no tool is pending, so a non-success outcome is purely an alarm — ours, raised
when the run's policy cannot be read, and raised before a single turn is spent.
The monitor reads the same code differently at the two events, deliberately.

### 4. The session never ended, and nothing else would have noticed

Found while wiring the gate demo, and by far the most expensive thing here.

In bidirectional stream-json mode the CLI waits on stdin, and the backend never
closed it. Measured against the real CLI through `HeadlessBackend`:

```
+0.0s  run_started
+1.1s  session_ready
+2.6s  assistant_text
+2.7s  result
+150.3s terminated  reason=timeout      ← wall-clock cap, then SIGTERM grace
```

Every run would have held its concurrency slot for its **entire** wall-clock
budget after finishing — 90 minutes for a Coder (A46) — and every one would have
been classified `timeout`, which downstream is a failure rather than a completed
task. At concurrency 2 (A7) that is a studio doing a handful of tasks a day and
calling all of them broken.

Invisible to every existing test, because the scripted stand-in exits by itself.
`HeadlessRunHandle.finishAfterResult` now closes stdin when the result arrives;
the same run terminates in **4.9 s** with reason `completed`. A second stub that
waits on stdin — like the real thing — guards it.

Two smaller consequences of closing stdin: `queryUsage()` returns null
immediately afterwards instead of waiting out the 15-second control timeout, so
§7.1's meter samples *during* a run rather than after it; and a non-zero exit
that arrives after a delivered result is classified `completed`, because the
work was done and reported before the shutdown misbehaved.

## The decision

- **The policy travels with the run, as a file.** `<runsRoot>/<runId>/containment.json`,
  written before the spawn beside the run's `--mcp-config`, named by
  `VORSCHICHT_RUN_POLICY`. Not a database query: the hook is a process spawned
  on every tool call, and a hook that needed Postgres would stop containing
  anything the moment Postgres hiccupped. A file it cannot read denies
  everything, which is the correct behaviour rather than a degraded one.
  That the document can be static is a property of §10, not a shortcut — claims
  are registered before a coder starts and a re-planned task is re-checked (A45).
- **The decision lives in `@vorschicht/shared/containment`,** a leaf importing
  only `claims.js`, `worktree.js` and `node:path`. Measured at ~1 ms over bare
  Node start-up, against a per-tool-call budget of ~50 ms. ADR 0003's warning
  applies here an order of magnitude harder: that was a 400 ms budget spent once
  per session, this is spent on every `Write`.
- **`--settings` documents are generated, validated, and re-verified at daemon
  start,** and the daemon refuses work if it cannot. A settings file that fails
  validation is discarded silently in `-p` mode, so this property has three
  independent checks: generation from one function, a strict schema on the way
  in *and* out, and runtime evidence that a hook fired (`ContainmentMonitor`).
- **No `permissions.deny` rules in those documents.** Claude Code can also refuse
  by pattern from settings, and a second mechanism is tempting — but an
  unrecognised key risks the whole document being discarded, taking the hooks
  with it, and the benefit would be a layer we cannot demonstrate the way
  `check-hook-containment.mjs` demonstrates the hook. A safeguard that is not
  demonstrated is not a safeguard.

## Consequences

- `ModelBackend.resume` takes a `ResumeSpec` with a **required** `settingsPath`
  and `env`. The previous signature carried neither, which meant §6.4's
  escalation round-trip would have resumed a parked session with containment
  switched off — at the exact moment the task starts writing again.
- `SessionSpec.env` exists, and `SessionPaths.policyPath` is required where
  `mcpConfigPath` is nullable. The asymmetry is the point: a session without MCP
  is degraded and says so, a session without containment is dangerous and
  nothing downstream would notice.
- What this still does not cover, stated rather than papered over: a broad
  `Grep` whose *output* includes a line from a `.env`. A `PreToolUse` hook
  allows or denies; it does not filter. The `glob`/`path` arguments are checked,
  and the residual is why A21 also runs gitleaks over new transcripts nightly.
  `Bash` is likewise §6.6's stated accepted limit — the Phase 2 gate demands
  proof that the Reviewer catches an out-of-claim edit with this hook
  deliberately bypassed, which is the layer that does not depend on knowing
  the tool.
