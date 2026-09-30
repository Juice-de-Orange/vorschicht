# ADR 0001 — How Vorschicht reads its own budget

- **Status:** accepted, **partially superseded** — two of its conclusions have
  been measured to be wrong since A73. They stand unchanged in the text, each
  carrying a note; the revision itself is Addendum 3 at the end. (The operator's
  decision of 2026-08-18, card #15, implemented as A149.)
- **Date:** 2026-08-01
- **Context:** §7.1, A29
- **Evidence:** `infra/scripts/spike-rate-limit.mjs`, run against CLI 2.1.220 on
  subscription auth (`max`). Raw transcript kept out of the repo; the payload
  excerpts below are verbatim.

## The question

§7.2 — the most safety-critical rule in this project — thresholds on a
*percentage* of each usage window. So the guardian needs a number, and it needs
to know what scale that number is on. A29 prescribed an evaluation order:
stream-json result metadata → transcript JSONL → statusline mechanism.

## What we found

**The first two do not exist.** The `result` message carries `usage`,
`modelUsage`, `permission_denials`, `total_cost_usd`, `terminal_reason` and
friends — checked field by field, no `rate_limit` anywhere. The transcript
JSONL carries token counts and `service_tier` only. A29's evaluation order was
written against an assumption that does not hold; this is recorded so no later
session searches there again.

**Two real sources exist instead.**

### 1. `control_request { subtype: "get_usage" }` — the only source of percentages

Works over `--input-format stream-json` on the pinned CLI. Abridged response:

```json
{ "subscription_type": "max",
  "rate_limits_available": true,
  "rate_limits": {
    "five_hour":  { "utilization": 2,  "resets_at": "2026-08-01T09:59:59.734298+00:00" },
    "seven_day":  { "utilization": 24, "resets_at": "2026-08-02T02:59:59.734320+00:00" },
    "seven_day_opus": null, "seven_day_sonnet": null, "tangelo": null, "…": null,
    "model_scoped": [{ "display_name": "Fable", "utilization": 11, "resets_at": "…" }],
    "limits": [
      { "kind": "session",       "group": "session", "percent": 2,  "severity": "normal", "resets_at": "…", "scope": null },
      { "kind": "weekly_all",    "group": "weekly",  "percent": 24, "severity": "normal", "resets_at": "…", "scope": null },
      { "kind": "weekly_scoped", "group": "weekly",  "percent": 11, "severity": "normal", "resets_at": "…",
        "scope": { "model": { "display_name": "Fable" } } }
    ],
    "extra_usage": { "is_enabled": false, "disabled_reason": "out_of_credits", "…": "…" }
  },
  "session": { "total_cost_usd": 0.37, "model_usage": { "claude-opus-5[1m]": { "inputTokens": 2, "…": "…" } } },
  "behaviors": { "…": "telemetry about this account's usage patterns" } }
```

### 2. `rate_limit_event` in the stream — a push signal without a number

Arrives unprompted, once per session:

```json
{ "type": "rate_limit_event",
  "rate_limit_info": { "status": "allowed", "resetsAt": 1785578400,
                       "rateLimitType": "five_hour", "overageStatus": "rejected",
                       "overageDisabledReason": "out_of_credits" } }
```

## Decisions

### The scale is percent, 0–100 — and that is now settled by observation

`five_hour: 2`, `seven_day: 24`, `model_scoped: 11`. Values above 1 can only be
percentages. This retires the ambiguity that `normaliseUtilization` was built to
survive: the guard stays (a future payload could still hand us a fraction, and
the failure mode — a guardian that never fires — is unacceptable), but the
configured scale is `percent`, no longer a guess.

### Read `limits[]`, not the per-window keys

The response exposes the same information twice, and the flat array is the more
durable shape:

- The keyed form contains **internal codenames** — `tangelo`, `iguana_necktie`,
  `omelette_promotional`, `nimbus_quill`, `cinder_cove`, `amber_ladder`. Whatever
  those are, they prove the key set is not a stable enum, and a meter that
  switches on key names will silently miss a window that gets renamed or added.
- `limits[]` names the *kind* (`session`, `weekly_all`, `weekly_scoped`) and
  carries `scope.model.display_name` for the per-model weekly cap, which §7.1
  requires and which nothing outside `get_usage` provides at all.
- It also carries `severity`, a vendor-side judgement that is worth recording
  next to our own threshold decision.

The keyed form is kept as a fallback for the case where `limits[]` is absent.

### The runner is bidirectional from day one

`get_usage` needs an open stdin (`--input-format stream-json`). This was the
single most expensive decision to reverse — a one-shot `claude -p "prompt"`
runner would have had to be rebuilt from the inside out — and the same channel
also carries `interrupt`, which A32 needs for the only cap that stops a run
*gracefully*.

### Persist `rate_limits`, never the whole response

`session.model_usage` is copied out separately as the token cross-check.
`behaviors` is **not** stored: it is telemetry about the account's overall usage
patterns, unrelated to this project's budget, and §18 keeps the event log
forever. Storing it would mean keeping unrelated data forever by accident.

### `rate_limit_event` is the corroborating signal, not the meter

> **Superseded since A73 (see Addendum 3).** The frame does carry a number —
> just not in the messages with `status: "allowed"`, which were the only ones
> this spike got to see. The sentence below stands as an observation that was
> true for the sample of the time.

No percentage, so it cannot drive §7.2 thresholds. It is useful for three
things: a `status` other than `allowed` means we are being throttled *right now*
regardless of what any percentage says; `resetsAt` corroborates the reset time;
and `overageStatus` tells us whether the account can spend money at all.

### Two timestamp formats, one normaliser

`get_usage` returns ISO 8601 strings, `rate_limit_event` epoch seconds. Both go
through `normaliseResetsAt`, which already handles seconds, milliseconds and ISO.

## Consequences

- `ModelBackend` exposes a `queryUsage()` capability; the `headless` backend
  implements it over the control channel, the `fake` backend serves fixtures.
- `usage_samples` stores the raw `rate_limits` object verbatim plus the
  normalised fields, so a future change of shape stays forensically recoverable.
- Unknown window kinds are recorded rather than dropped — an unrecognised
  `kind` is data about the vendor changing something, and §7.1's "tightest
  governing window wins" is safer when it can see windows it does not know.
- `extra_usage.is_enabled: false` is asserted at startup: it is the account-level
  half of §2's no-money rule, and now it is checked rather than assumed.

## What this costs

The spike itself consumed roughly 0.37 USD-equivalent of subscription budget in
one turn, most of it cache creation, because it inherited an Opus session. Runs
made by the runner set `--model` per role, so this is not representative — but
it is a reminder that "one short session" is not free, and that the guardian
being built on top of this is not a formality.

---

## Addendum, 2026-08-01 (later the same day) — the source stopped answering

Not a revision: what is recorded above was observed and was true. This is what
changed afterwards, and the two together are the point.

Verified from the orchestrator container, on the same subscription token, at two
moments in the same session — immediately after `system:init` and again after the
`result` message had arrived:

```json
{ "subscription_type": null,
  "rate_limits_available": false,
  "rate_limits": null,
  "session": { "total_cost_usd": 0.0146, "model_usage": { "claude-haiku-4-5": { "…": "…" } } },
  "behaviors": { "day": { "request_count": 5, "…": "…" } } }
```

`session` and `behaviors` are populated, so the endpoint works and the session is
real. The three fields §7.1 depends on are the ones that are gone.

Two facts worth keeping apart:

- **The timing finding is permanent and useful.** `get_usage` answers
  `rate_limits_available: false` *before the session has made an API call* under
  any circumstances. The runner had only ever sampled at `session_ready`, which
  is the one sample a short session reaches, so short sessions were structurally
  blind even when the source was healthy. It now also samples on `result` — the
  last instant at which anyone is listening, because the backend closes stdin
  immediately afterwards (A51.5).
- **The absence of `rate_limits` is new and its cause is unknown.** It may be
  transient, it may be an account-level change, it may be a step in the billing
  rework §6.0 exists for. This ADR does not guess.

### What follows

`evaluateGuardian` treats an unreadable budget as `wrap_up`, which is correct and
means the studio starts no work at all. Nothing about that is being relaxed
(§0.3). §7.1's fallback — the token-accounting meter of A6 — is the designed
answer and its *producer* has never been built: `UsageMeter.ingestEstimate`
accepts a percentage and nothing computes one. That is the work this addendum
points at, and the decision about how far to trust an estimated budget is the
operator's (raised as an inbox decision rather than taken by the build).

## Addendum 2, 2026-08-01 (evening) — it did not stop; it does not answer under token auth

The first addendum concluded that the source "stopped answering". That reading
was wrong, and wrong in a way that mattered: it framed a permanent property as
an outage that might pass, which is the difference between a temporary bridge
and the architecture.

A controlled experiment settles it. **One machine, one CLI build, two runs
minutes apart, one variable** — the same `spike-rate-limit.mjs`, the same
subscription, the token read straight out of the running orchestrator container:

| auth | `subscription_type` | `rate_limits_available` |
|---|---|---|
| interactive claude.ai login (`~/.claude/.credentials.json`) | `"max"` | `true` |
| `CLAUDE_CODE_OAUTH_TOKEN` | `null` | `false` |

Two competing explanations were eliminated rather than argued away:

- **The container.** Both runs above are on the *host*. The container merely
  reproduces the token row, which it must, since that is how it authenticates.
- **The CLI version.** `claude --version` reports `2.1.220 (Claude Code)` on the
  host and inside the container. The first addendum's observation and this one
  were made on the same build.

What remains is the auth mode alone, and the original observation in this ADR is
consistent with it: that session authenticated interactively.

Consequences are recorded as A64. In short: the estimating meter of A60 is the
primary meter for as long as A5's setup-token is the auth, its calibration is a
standing decision rather than a stopgap, and there exists a documented way back
to official data — mounting an interactive credential into the claude auth
volume — whose price is stated in §6.1 and which is the operator's to weigh,
not the build's to take.

> **Superseded since A73 (see Addendum 3).** "Primary meter for as long as the
> setup-token is the auth" now holds only **below 75 %**. Above that, the pushed
> channel delivers the official figure and `projectSamples` lets it win — which
> is exactly the band in which §7.2 has to act.

---

## Addendum 3 (2026-08-25) — the revision the operator ordered

The internal audit of 2026-08-16 (domain `assumption_revision`) filed this ADR
as an **expired assumption**: it stands at `accepted` and records two
conclusions that A73 has refuted by measurement, while the code has been built
differently ever since. On 2026-08-18 the operator chose "revise the assumption
— fix the new wording" via card #15. This addendum is that revision.

**What A73 measured.** Across every build transcript of 2026-08-01 there are 35
`rate_limit_event` frames: **29 with `status: "allowed"`, not one of them
carrying a number** — that is the sample this ADR drew its sentence from — and
**6 with `status: "allowed_warning"`, every one of them carrying `utilization`
and `surpassedThreshold`**, for `five_hour` and `seven_day` alike. The second
shape had never appeared here because the account had never been that deep
into a window.

**What follows from that, and what does not.**

* The ADR was **right** for its sample and is **wrong** for the general case.
  That is not the same thing as a mistake, and the difference belongs here: an
  observation that was generalised from too narrow a slice.
* The official reading is **obtainable** under A5's auth — not on demand, not
  below the vendor's warning threshold, but exactly in the band in which §7.2
  acts.
* A64's diagnosis ("not an outage but a property of the auth mode") remains
  valid, unchanged, for the **pulled** channel (`control_request { get_usage }`).
  Only the statement about the **pushed** one is affected.
* The ingest keys on `utilization !== null` and **not** on the status word
  (A73.4) — so a genuine refusal carrying a figure would reach the guardian
  immediately, even if the vendor changes its vocabulary.

**Why the old text stays.** An ADR is the record of what was known at the time
of the decision; rewriting it would take away the next reader's chance to see
*how* the false assumption arose — and that is the real lesson here. What was
missing was the addendum, not a correction of the original. That is precisely
why §8.2's fourth domain filed it: an assumption nobody revises is a decision
that has quietly stopped being true.
