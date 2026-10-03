# OPERATIONS — running Vorschicht

This document is the operations guide for anyone who runs Vorschicht — an
autonomous Claude Code orchestrator, the "software studio" described in
`CLAUDE.md` — on their own host. It covers start/stop, recovery, the failure
modes that have actually occurred, and how to read what §12's deployment
engine leaves behind.

Two things to know before reading on:

* **The project is experimental and not in production use.** Everything below
  was written against a single first production host and a build machine; the
  procedures are real, the scale is small.
* **All commands assume a Linux host with Docker Compose.** Host-specific
  values — hostnames, data roots, tokens, SMTP — live in the stack's `.env`
  (see `.env.example`), never in this document. Where a command needs the SSH
  host of your production machine, it is written as `<host>`.

The rule for **incidents** in this document: an entry is added when the problem
has actually occurred and the fix does not follow from the code — not
pre-emptively, because nobody reads a collection of invented failures. The
seven procedural sections that §22 step 4 names (start/stop, restore, token
renewal, passkey rescue, watchdog, disk space, account checklist) and the §12
rollout walk-through are the exception: they are written *before* their first
incident, because a rollback happens unattended, announces itself as a card in
the inbox, and the question "is production serving again or not" has to be
answerable in a minute, not after an hour of reading source. Everything below
was read off the code, not copied from §12; where text and code diverge, it
says so.

One more reason the disk-space section exists: `disk-watch.ts:558` writes
"OPERATIONS.md, disk-space section" into **every delivered disk alert**. A dead
reference in an alert is worse than none — it costs time exactly when there is
none.

---

## Start, stop and state of the stack

Everything runs on the production host from the stack directory (`/opt/vorschicht`
in the examples below; adjust to your checkout). The two Compose files
**always** belong together — the override carries the bind mounts under the
data root (`/srv/vorschicht` by default), and without it the stack starts with
empty volumes. Copy `infra/docker-compose.override.example.yml` to
`docker-compose.override.yml` once and keep it next to the base file.

```bash
ssh <host>
cd /opt/vorschicht
alias vc='docker compose -f infra/docker-compose.yml -f docker-compose.override.yml --env-file .env'

vc ps                 # state of all four services
vc up -d              # start (idempotent)
vc stop               # halt, data stays
vc restart orchestrator
vc logs -f --tail 100 orchestrator
```

**What "healthy" means:** `db`, `app`, `orchestrator` and `backup` report
`running (healthy)`. All four carry a healthcheck. A service showing `running`
without `(healthy)` is still starting — the orchestrator runs its self-check
(§6.1) at start-up and needs one model session for it.

**`(healthy)` on the orchestrator means "the process is alive", not "it is
working".** Its healthcheck is a heartbeat file, and during an auth incident
(§6.1) the daemon idles on purpose instead of exiting — so the container stays
`running (healthy)` while it takes no work. Look at the dashboard's overview
instead (a red "Auth-Vorfall" strip directly under the verdict, which then only
says "Keine Budgetdaten"), at `vc logs orchestrator` (`Selbstprüfung rot`), or
at the `auth.incident` rows in `event_log`.

**Never `vc down`,** unless you really want the networks torn down. `stop` is
enough for everything, and `down -v` would take the volumes with it.

**The stack comes back by itself after a host reboot:** all four services carry
`restart: unless-stopped`. The watchdog timer additionally fires two minutes
after boot (`OnBootSec=2min`).

**The project name is fixed.** `infra/docker-compose.yml` sets `name: vorschicht`,
so the containers are `vorschicht-db-1`, `vorschicht-app-1`, … and the network
is `vorschicht_default` wherever the checkout lives. This document and the
`*-remote.sh` scripts (`onboard-remote.sh`, `audit-remote.sh`,
`kennzahlen-remote.sh`, `budgetfenster-remote.sh`) address the containers by
those names. Two stacks on one host collide on them; a second one has to be
started with `docker compose -p <other-name> …` on every command, and those
scripts will then not find it.

---

## First project (onboarding, §20)

A fresh stack has no project, and nothing in the dashboard creates one. The
one exception is the studio's own checkout: found at `/projects/vorschicht`
(that is, `<projects root>/vorschicht` on the host), it registers itself at
start without a session (A42); otherwise the log says "Kein selbstverwaltetes
Projekt" and the internal audit does not run. Every other project is created by applying an **onboarding proposal**: a session reads the
repository and proposes its gates, claim granularity and deployment method;
`verifyProposal` checks the proposal against the repository's real manifests;
you read it; only then is the project row written (A41: dry run first, applying
is a separate act).

**This needs the Claude subscription.** The analysis is one real Claude Code
session at the strongest tier and spends subscription budget. With the
`.env.example` placeholder as `CLAUDE_CODE_OAUTH_TOKEN` it ends as an auth
incident: exit code 2, no proposal.

**How far this section has been tested.** It was read off the scripts
(`onboard-remote.sh`, `onboard.sh`, `onboard.mjs`) and checked against them
line by line; the argument handling and the refusals below were run. The
procedure as a whole — a session that produces a proposal, and applying it —
has **not been executed end to end in the published state** of this repository,
because that takes a subscription. Treat the first run as a test of this
section, and report what does not match.

**Before you start**

- The repository must be a git checkout **below the projects root**
  (`VORSCHICHT_PROJECTS_ROOT` on the host, mounted at `/projects` in the
  orchestrator). The project row stores the path the *orchestrator* sees
  (`/projects/<directory>`), not the host path.
- `<repo>/.git` must belong to uid **10001** — the orchestrator runs as that
  user and creates the task worktrees there. `onboard-remote.sh` refuses
  otherwise and prints the `chown`.

**On the host the stack runs on** — `infra/scripts/onboard-remote.sh`, run from
any machine that reaches the host by non-interactive SSH. It expects the stack
checkout at `/opt/vorschicht` on the host (`VORSCHICHT_REMOTE_ROOT`), its
`.env` with the token, the running container `vorschicht-orchestrator-1` and
the network `vorschicht_default` (`VORSCHICHT_REMOTE_NET`).

What it does on the host besides the analysis, so that none of it is a
surprise:

- **It builds the gate image** (`vorschicht-gate:local`, from
  `infra/docker/Dockerfile.gate`) on every call. After the first time that is a
  cache hit; the first time it downloads and installs for several minutes.
- **It may install and build inside the stack checkout.** The session runs in
  that image with the checkout mounted at `/work`; if `packages/core/dist` is
  missing there, it runs `pnpm install --frozen-lockfile` and the build first,
  which writes `node_modules` and `dist` into the checkout as your SSH user.
- **It assumes the override layout and passwordless `sudo`** for one step:
  afterwards the session transcript is copied into the backed-up transcripts
  directory with `sudo -n cp` and `sudo -n chown` — `/srv/vorschicht/transcripts`
  unless `VORSCHICHT_REMOTE_TRANSCRIPTS_DIR` says otherwise. Without
  passwordless sudo, or on a stack that keeps its transcripts in the base
  file's named volume, the run still completes; the script then prints the
  temporary directory the transcript was left in, and moving it is yours.

```bash
# 1. Dry run: one session, mounts the repository read-only, creates nothing
infra/scripts/onboard-remote.sh --host <host> \
  --repo /opt/example-app --slug example-app --name "Example App"

# 2. Read the proposal: docs/onboarding/example-app.md in the stack checkout on
#    the host, and the card in the inbox. The document names the run id ("Lauf").

# 3. Apply exactly that proposal — no second session
infra/scripts/onboard-remote.sh --host <host> --apply-lauf <runId> --actor <your-name>
```

The script sets `--path` itself, to `/projects/<basename of --repo>`; that only
matches what the orchestrator sees if `--repo` is a direct child of the
projects root. Add `--read-only` to step 1 for a project the studio may analyse
but never write to.

`--actor` names who approved, lands in `audit_log`, and has **no default**:
step 3 refuses to run without it (exit 2). `onboard.mjs` also reads it from
`VORSCHICHT_ACTOR`, which helps with `pnpm onboard`; `onboard-remote.sh` does
not carry your environment to the host, so there it has to be the flag.

Step 3 also refuses a run id it does not know and a proposal the verification
rejected — both with exit **2**, not 1: nothing was applied and nothing was
analysed, and the message says which of the two it was.

**From a checkout** — `pnpm onboard` (`infra/scripts/onboard.sh`) runs the same
analysis with the `claude` CLI on your `PATH`:

```bash
pnpm onboard -- --path /abs/path/to/repo --slug example-app --name "Example App" --read-only
```

Without `DATABASE_URL` in the environment it uses a throwaway Postgres: the
proposal document is written to `docs/onboarding/<slug>.md`, but nothing
reaches the stack's database, so there is nothing to apply later. It is the way
to see what a proposal looks like, not the way to add a project to a running
stack — for that the run has to write to the stack's database and `--path` has
to be the path the orchestrator sees, which is what `onboard-remote.sh`
arranges.

Exit codes of both: **0** proposal stands (or was applied) · **1** the session
produced a proposal and the verification refused it (also: `--apply` in the
same run as such a proposal) · **2** nothing was analysed or applied — infra, a
token that does not authenticate, a missing `--actor`, or an `--apply-lauf` that
was refused · **3** the session ran and delivered nothing usable.

The session transcript is archived under `VORSCHICHT_TRANSCRIPTS_ROOT` (else
`<VORSCHICHT_DATA_ROOT>/transcripts`); `onboard-remote.sh` sets the former. A
`pnpm onboard` with neither set keeps it in its scratch directory, deletes it
with that directory at the end, and says so.

---

## Restore a backup

**The probe first, never the real restore straight away.** `restore-probe.sh`
performs exactly what a restore would do, into a throwaway Postgres, and tells
you whether the backup holds — without touching anything:

```bash
ssh <host>
sudo /opt/vorschicht/infra/scripts/restore-probe.sh
```

Six stages, and the output names its own limits. Exit **0** means: yesterday's
generation loads, the schema is ours, the transcripts that `agent_runs` points
at really are in the archive, and a deleted file produces exactly one gap (the
counter-check — without it, "0 missing" would be indistinguishable from a
broken join). Exit **1** is a finding; exit **2** means "nothing checked" and is
**not** an all-clear. On a stack that has not run a single session yet, stage 5
is a finding by design ("Kein einziger Lauf nennt ein Transkript"): there is
nothing for it to check, and it says so rather than passing.

The probe looks for *yesterday's* generation and reports its absence as a
finding (exit 1) — on a stack younger than a day, too. `--generation <stamp>`
names another one (the stamp is the `YYYYMMDD-HHMMSS` part of the file names),
and `--backups <dir>` another directory.

**Where the backups are** depends on how the stack was started:

- **With the host overlay** (`docker-compose.override.yml`):
  `/srv/vorschicht/backups/daily` (14 kept) and `.../weekly` (8) — the probe's
  default.
- **With the base compose file alone** (the README quick start): in the named
  volume `vorschicht_backups`, at `/backups/daily` and `/backups/weekly` inside
  the `backup` container. The probe reads a directory, not a volume, so copy
  the generations out first:

  ```bash
  mkdir -p /var/tmp/vorschicht-backups
  docker run --rm -v vorschicht_backups:/backups:ro -v /var/tmp/vorschicht-backups:/out \
    postgres:16-alpine sh -c "cp -r /backups/daily /out/ && chown -R $(id -u):$(id -g) /out"
  infra/scripts/restore-probe.sh --backups /var/tmp/vorschicht-backups/daily
  ```

Every night at 02:30, three files with the same timestamp appear:
`db-<stamp>.dump`, `docs-<stamp>.tar.gz`, `transcripts-<stamp>.tar.gz`.
`vc exec backup ls /backups/daily` lists them in either layout.

**The real restore**, should it ever be needed — order matters. `vc` is the
alias from the first section; with the base compose file alone it is
`docker compose -f infra/docker-compose.yml --env-file .env`.

```bash
vc stop orchestrator app          # nobody may write while loading

# 1. An empty database. Connected to `postgres`, not to `vorschicht`: a database
#    cannot be dropped by a session that is connected to it. Two -c, because
#    DROP DATABASE cannot run inside the transaction a single -c with two
#    statements would be.
vc exec -T db psql -U vorschicht -d postgres \
  -c 'DROP DATABASE vorschicht' -c 'CREATE DATABASE vorschicht'

# 2. The dump, read where the sidecar keeps it (works in both layouts; the
#    `backup` service has to be running).
vc exec -T backup cat /backups/daily/db-<stamp>.dump \
  | vc exec -T db pg_restore -U vorschicht -d vorschicht \
      --exit-on-error --no-owner --no-privileges

# 3. Documents and transcripts — see below for the layout you run.

vc up -d
```

`-U vorschicht` and the database name are the `.env.example` defaults
(`POSTGRES_USER`, `POSTGRES_DB`); use yours if you changed them. If step 1
answers "database is being accessed by other users", something else is still
connected — stop it, or use `DROP DATABASE vorschicht WITH (FORCE)`.

Step 3 **with the host overlay** — the archives unpack to `docs/` and
`transcripts/` below the data root:

```bash
sudo tar -xzf /srv/vorschicht/backups/daily/docs-<stamp>.tar.gz        -C /srv/vorschicht
sudo tar -xzf /srv/vorschicht/backups/daily/transcripts-<stamp>.tar.gz -C /srv/vorschicht
sudo chown -R 10001:10001 /srv/vorschicht/docs /srv/vorschicht/transcripts
```

Step 3 **with the base compose file alone** — the same, into the named volumes,
through a throwaway container (the `backup` service mounts both read-only and
cannot do it):

```bash
docker run --rm \
  -v vorschicht_backups:/backups:ro \
  -v vorschicht_docs:/data/docs -v vorschicht_transcripts:/data/transcripts \
  postgres:16-alpine sh -c '
    tar -xzf /backups/daily/docs-<stamp>.tar.gz        -C /data &&
    tar -xzf /backups/daily/transcripts-<stamp>.tar.gz -C /data &&
    chown -R 10001:10001 /data/docs /data/transcripts'
```

Unpacking adds and overwrites; a file created after the backup stays where it
is. The database then has no row for it, which is harmless for the vault and
the trace views — delete the directories' contents first if you want the exact
state of the backup.

**What explicitly does not happen:** the migrations are **not** run again. The
dump carries its schema and its `_vorschicht_migrations` rows with it; a
`migrate()` on top would be a no-op at best. If the number of migrations in the
dump does not match the deployed code, that is a finding and not a detail —
stage 3 of the probe asks exactly this.

**Off-site copies:** A14 describes an rsync of the backup directory to a
second host (A35). Whether you configure one is your decision; without it, a
disk loss on the production host takes the backups with it, and that is a
consciously carried risk, not an oversight the software covers.

---

## Renew the OAuth token

**The expiry cannot be queried, only remembered.** `claude auth status` reports
`loggedIn`, `authMethod` and `apiProvider` — **no date**. Vorschicht therefore
records the installation time in `/srv/vorschicht/claude/token-installed.json`
and counts back from A5's documented lifetime (about a year): a warning at
**30** days remaining, a P0 card at **7**.

A dead token is no small thing for an unattended system. §6.1 turns it into an
**incident** rather than a failed task — the daemon idles, alerts via
`vorschicht-alerts` and **parks** the running tasks instead of marking them
red. Contained is not the same as warned in time, and A28 demands both.

**Renewing:**

```bash
# 1. On a trusted machine with a browser (not on the production host):
claude setup-token
# 2. Put the token into the .env on the production host:
ssh <host>
cd /opt/vorschicht
sed -i 's|^CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=<new-token>|' .env
# 3. Reset the installation timestamp, otherwise A28 keeps warning:
sudo rm -f /srv/vorschicht/claude/token-installed.json
vc restart orchestrator
vc logs --tail 30 orchestrator     # the self-check must pass (§6.1)
```

**What a token that does not authenticate looks like.** `claude auth status`
reports `loggedIn` for any token that is set, so the first thing to notice is
the start-up probe (§6.1). Its failure is an auth incident like any other: the
log says `Selbstprüfung rot` with "Die Sitzung konnte sich nicht anmelden",
`event_log` gets an `auth.incident`, `vorschicht-alerts` gets "Auth-Vorfall —
Daemon nimmt keine Arbeit an", and the probe is repeated every five minutes.
If that push does not get through, the log says `Alarm über ntfy nicht
zugestellt` and the event row carries `announced: false` with the error — the
overview's "Auth-Vorfall" strip repeats it.
`Selbstprüfung bestanden — Daemon ist bereit.` does not appear until a session
has authenticated.

The token lives **only** in the auth volume and in the `.env` on this host
(A5). Carrying it elsewhere for a run is not a path this project knows — which
is also why the internal audit runs on the production host and not locally
(A135).

---

## Passkey rescue

**If you have locked yourself out** — both devices lost, or sign-in fails. The
path goes over SSH, and that is deliberate: whoever reaches the host outranks
any passkey anyway.

```bash
ssh <host>
cd /opt/vorschicht
vc exec app node dist/cli/invite.js --purpose=rescue
```

The CLI is part of the **`app`** image; the orchestrator image does not contain
it. `--purpose rescue` and `--purpose=rescue` are the same; an argument the
CLI does not understand is refused with a usage line (exit 2) instead of
falling back to an ordinary `bootstrap` invitation, as it once silently did.

This prints **one** link. Open it on the device that is to receive the new
passkey, enter a device name, register.

* The link is valid for **15 minutes and exactly once**.
* The token sits behind the `#` and is **never transmitted to the server** —
  it appears in no access log and no referer.
* It is stored only as a hash. A lost link cannot be recovered; generate a new
  one.

**Without `--purpose=rescue`** the same command produces an ordinary invitation
for an additional device. §19 requires **two** credentials before registration
locks; whether any are on file is answered by a route that responds without a
session:

```bash
curl -s https://vorschicht.example.com/api/auth/state
# {"bootstrap":{"complete":true,"credentialCount":2,"missing":0},"hinweis":"…","angemeldet":false}
```

*(Since A147 the registration sends at most **32** existing credentials as
`excludeCredentials`, newest first. Above that, the browser rejects the whole
ceremony — an account with 64 passkeys could otherwise not have registered
another one, not even via this rescue path.)*

---

## What the watchdog does

A **systemd timer on the host**, outside the Compose stack, every two minutes.
It checks two things: the health state of the containers and the orchestrator's
heartbeat (at most **180 s** old; the daemon writes every 30 s).

```bash
systemctl status vorschicht-watchdog.timer
systemctl list-timers vorschicht-watchdog.timer
journalctl -u vorschicht-watchdog.service --since '1 hour ago'
cat /var/lib/vorschicht/watchdog.state          # ok | failing <since> <reported>
cat /var/lib/vorschicht/watchdog.audit.log      # every start attempt, timestamped
```

**What it does when something is broken:**

1. An alert via `vorschicht-alerts` — on the **transition**, not on every run.
   Before that rule it was 2,026 pushes for **one** seven-day outage; now it is
   29 (A102).
2. **Exactly one** start attempt (`docker compose start`), audit-logged. After
   that the phase is `failing`, and only alerts follow — no restart carousel.
3. An **all-clear** when things run again. Without it, "outage over" and
   "channel silent" look the same from a phone.
4. A reminder every six hours for as long as the outage lasts.

**The state survives a reboot** — `/var/lib/vorschicht` is a `StateDirectory`,
not `/tmp`.

**The consciously carried blind spot (§18.1):** if the host is completely
down, there is no alert path when ntfy runs behind the same nginx. Documented
rather than mitigated; if your ntfy lives elsewhere, this blind spot does not
apply to you.

---

## Disk space

*This is the section `disk-watch.ts` points to in every disk alert.*

**The thresholds:** from **80 %** a warning (Ops tile and `vorschicht-info`),
from **90 %** an alert via `vorschicht-alerts` — and then Vorschicht cleans up
**itself**, but only what was due anyway: images and releases beyond the
retention count, expired raw transcripts (A15). **The event log is never
touched.**

```bash
ssh <host>
df -h /                      # the number the alert means
docker system df             # what Docker holds
sudo du -sh /srv/vorschicht/*
```

**What can be removed safely, in this order:**

```bash
docker builder prune -af     # pure cache; costs only the next build
docker image prune -f        # only orphaned (untagged) images
docker images --format '{{.Repository}}:{{.Tag}}\t{{.Size}}' | sort -k2 -h -r | head -20
```

The last line lists the largest images. **Old images of other projects on a
shared host are, in experience, the biggest item** — on the first production
host, two months-old spike images of unrelated projects held more than 20 GB
between them. They do not belong to Vorschicht; removing them is the
operator's decision.

**What is not removed:** `/srv/vorschicht/postgres`, `/srv/vorschicht/docs`,
the event log, and backups inside their retention period.

*Observed on the build machine: a full disk makes the gate run abort while
downloading the test browser — and leaves behind a **half-installed** browser
that a presence check takes for installed. The browser suite then no longer
ran and reported "nothing checked", so it blocked nothing, while five ticked
gates rest on it (A150).*

---

## Account checklist

**Once, and it is the only assurance this repository cannot give itself.** §2
forbids API keys and usage credits outright; the daemon refuses to start if
`ANTHROPIC_API_KEY` is set at all. The code covers that. The **account** is
covered only by the account setting.

In the Anthropic account, **Usage Credits / Extra Usage must be disabled or
capped at 0**.

**Verify instead of assuming** — every real session says so itself:

```bash
ssh <host>
docker exec vorschicht-db-1 psql -U vorschicht -d vorschicht -tAc \
  "select raw -> 'overageStatus' from usage_samples where raw ? 'overageStatus' order by observed_at desc limit 1"
```

Expected is `"rejected"` — then overflow is off. A correctly configured account
answers with `overageStatus: "rejected"` and an `overageDisabledReason` such
as `"org_level_disabled_until"`.

---

## The daemon does not start: "directories not writable"

**Symptom.** The orchestrator exits at start-up with a list of paths under
`/data` and sends a `vorschicht-alerts` alert with the same text.

**Cause.** Docker seeds a *fresh* named volume from what the image has at the
mount point — ownership included. Where the image has nothing, Docker creates
the mount point as `root:root`. The daemon runs as uid 10001. Early images
created only `/data/runs`, so `transcripts`, `docs` and `worktrees` came up
root-owned. The image now creates all four — but an **already existing** volume
keeps its ownership; rebuilding the image changes nothing about that.

**Why this was not harmless.** Both consequences were silent: the transcript
copy from §6.2 failed on every run (one warning line, while the traceability
chain from §18 and the backup from A14 stayed empty), and
`WorktreeManager.ensure()` could not create anything — **not a single task of
the dev chain could ever have run**, each failing with a git error nobody would
connect to a volume permission. That is why the daemon checks this at start-up
and refuses service, instead of noticing when it is too late.

**Fix**, once on the host, in the stack directory:

```bash
docker compose -f infra/docker-compose.yml --env-file .env \
  run --rm --user root --entrypoint chown orchestrator -R 10001:10001 /data
docker compose -f infra/docker-compose.yml --env-file .env up -d orchestrator
```

On a host with the override file, add it:
`-f infra/docker-compose.yml -f docker-compose.override.yml`.

**Check:**

```bash
docker compose ... exec orchestrator ls -ld /data/runs /data/transcripts /data/docs /data/worktrees
```

All four must belong to `vorschicht vorschicht`.

---

## The backup container does not start: "/backups is not writable"

**Symptom.** The `backup` service exits immediately after start with exactly
this line and the `chown` command beneath it. No backup run happens.

**Cause.** The same as for the daemon one section up, with the sign reversed:
the sidecar used to run as uid **70** (the `postgres` user of the base image)
and now runs as **10001**, like the volumes it copies. An **already existing**
`backups` volume keeps its ownership, so it still belongs to uid 70 — and
Docker does not reset it, because it seeds a volume from the image only when
the volume is *empty*. On every installation that has backed up at least once,
that is the normal case.

A host prepared with `install-host.sh` before the script was corrected shows
the same symptom on its very first start: the script used to hand
`<data root>/backups` to uid 70. Re-running it repairs the ownership.

**Why the switch was necessary.** The sidecar could not read the transcripts.
They belong to uid 10001 and carry mode 0600 (the copy inherits the mode of
the CLI transcript file), so `tar` failed on the first file — **after**
`pg_dump` and the documents archive had already succeeded. The run aborted,
`.last-run` was never written, the healthcheck was therefore permanently red,
and on the first production host the watchdog alerted every two minutes for
seven days. For each of those nights there was additionally a
`transcripts-*.tar.gz` of **130 bytes** in `/backups/daily` — a name that looks
like a backup, and nothing inside. A14's assurance that transcripts are in the
backup was thus never met; before that the volume had been empty (A58.2), so
there was nothing for it to fail on.

**Fix**, once on the host, in the stack directory:

```bash
docker compose -f infra/docker-compose.yml --env-file .env \
  run --rm --user root --entrypoint chown backup -R 10001:10001 /backups
docker compose -f infra/docker-compose.yml --env-file .env up -d backup
```

**Check:**

```bash
docker compose ... exec backup sh -c 'id; ls -ld /backups; cat /backups/.last-result'
```

`id` must show 10001, `/backups` must belong to `vorschicht vorschicht`, and
`.last-result` must say `outcome=ok`.

**Why the container refuses rather than trying.** Without this check the
condition reports under a false name: the first thing to fail is
`pg_dump --file=…` with EACCES, so the log and the result document would say
"pg_dump failed" and the reader would look for the error in the database —
while the container keeps running and stays silently unhealthy. That is A58.2
one floor down, and the answer is the same one `checkWritablePaths` gives the
daemon.

---

## What a backup run leaves in the log

Every run leaves `/backups/.last-result` with the outcome **per component**:

```
schema=1
started_at=1786284443
finished_at=1786284444
stamp=20260809-140723
outcome=failed
db=ok
docs=ok
transcripts=failed
prune=skipped
problem=tar for transcripts failed
```

`skipped` means "never attempted" — the run aborts at the first failure, and
the components after it say so instead of looking like a second failure. The
daemon reads the file on every pass and writes `backup.succeeded` or
`backup.failed` into the event log (§18). **Over ntfy it reports only the
transition**, not every run: at most one alert per outage and one all-clear, so
the channel stays usable (A67.6, A86.5). An outage lasting three nights yields
three event rows and one alert.

`.last-run` keeps its old meaning: only a **fully** successful run writes it,
and the container's healthcheck checks exactly that (younger than 48 h). A
partial success therefore remains a failure — now visible with the component
named.

---

## The daemon runs but starts no work

The guardian (§7.2) deliberately refuses every new session for as long as it
cannot read the budget — an unreadable budget is not a safe budget. The log
then says:

> Start-up probe ran but delivered no budget value — the guardian stays closed
> as a precaution (§7.1).

That is **not a daemon error** but the intended reaction.

Two things are settled about this state:

- `control_request { get_usage }` **never** answers under
  `CLAUDE_CODE_OAUTH_TOKEN`; that is not an outage (A64 corrected A59's
  diagnosis).
- The official percentage still arrives, only from 75 % upward: the
  `rate_limit_event` messages carry `utilization` exactly when their `status`
  is `allowed_warning` (A73). Below that, the estimating meter from §7.1/A6
  governs — which **is built** (A60) and halts at
  `DEGRADED_WRAP_UP_PERCENT` = 75 % instead of the official 85 %.

A daemon that can read nothing at all is thereby reduced to the state
*fresh installation, not a single session yet*.

See for yourself what the source says:

```bash
docker compose ... exec db psql -U vorschicht -d vorschicht \
  -c "SELECT window_kind, used_percent, source, anomaly, observed_at
      FROM usage_samples ORDER BY id DESC LIMIT 5;"
```

`anomaly = {"kind": "unavailable"}` means: **this one reading** was blind —
since A60/A73 no longer "operations are paused". The column that answers the
question is `source`: measurement (`official`) or estimate (`estimated`). From
75 % upward the measurement wins — simply because it is a measurement and the
other is an estimate (A73.1, A60.7).

*(A lesson from the first production host: a pair of readings such as
"official 95 %, estimated 0.02 %" proves nothing on its own. In that case the
two counters had not diverged at all; it was the defect A98 fixed — a stale
official row was being held against a fresh estimate of the **next** window,
because the comparison lacked an age and window bound. That produced 1,892
anomaly rows in 23 hours. Since A98 an official row with `resets_at` in the
past is not compared at all.)*

---

## Rolling out Vorschicht itself (self-deploy, A12)

Not to be confused with §12's deployment engine, which the studio applies to
*other* projects — that is further down. This is about bringing a new version
of the studio onto its own host.

```bash
infra/scripts/rollout-remote.sh --host <ssh-host> --freigabe "<who approved>, <date>, <where it was said>"
```

The runner is **git-based** (`git fetch` + `git reset --hard <sha>`) and
explicitly no longer `rsync`. Four reasons, each sufficient on its own: a wrong
exclusion line with `--delete` silently deletes foreign files · `.git` survives
by construction instead of relying on an exclusion line (without it the
self-onboarding check refuses, and §8.2's cadence goes silent) · the unversioned
`.env` likewise · and the deployed state is an **exact sha** instead of
"whatever happened to be in the working tree".

**`--freigabe` checks nothing — it writes down.** A12 requires the operator's
approval every time; the script cannot know whether it is genuine, so it
records the wording, so that afterwards it is on record what a rollout invoked.

| Exit | Meaning |
|---|---|
| **0** | deployed **and** healthy — the answer comes from the server, not from the script |
| **1** | deployed and **not** healthy. A different state from "not deployed" |
| **2** | nothing done (see the five abort reasons) |

The five abort reasons, each with its own message: no `--freigabe` · the local
working tree is dirty · `HEAD` ≠ `origin/main` (otherwise the server fetches an
older state than the one you meant to deploy — the error you only notice from
the behaviour) · the working tree **on the server** is dirty (it is shown, not
overwritten) · the `.env` is missing.

**A trap that has bitten once:** the approval text travels as base64.
`ssh host bash -s -- a b c` preserves **no** argument boundaries — everything
after the hostname is joined and re-split on the far side. A parenthesis in the
approval text aborted the run with `syntax error near unexpected token '('`
before anything happened. That was harmless only because the rollout thereby
did *not* run at all; a `;` or backticks would have been **executed** over
there, in exactly the script whose sole purpose is to record A12's approval.

---

## Running the internal audit (§8.2)

```bash
infra/scripts/audit-remote.sh --host <ssh-host> --domain gate_truth --trigger phase_close \
  --scope "…" [--baum /tmp/<candidate>]
```

It runs **in the gate image on the production host**, against the production
database, and not on the build machine. The reason is an assurance:
`buildRoleSettings` refuses a hook path with backslashes, because a quoting
scheme is one more thing that can be silently wrong — and a split hook path
means §6.6's containment does not run. Three other ways out were examined and
rejected (A135).

The path is also the better one: there the audit has the **real event log** as
counter-evidence, and its findings land in the operator's inbox instead of a
throwaway database.

The **verdict is the exit code** and is passed through:

| Exit | Verdict |
|---|---|
| **0** | `unbedenklich` (nothing to object to) |
| **1** | `funde_zu_beheben` (findings to fix) |
| **3** | `phase_nicht_abschliessbar` — a gate has been invalidated |
| **2** | **nothing checked** (A25) — no statement, no finding |

`--baum <path>` audits a **candidate** instead of the deployed state. That is
the order the operator's approval demands: green gate **and** green audit,
*then* rollout. An audit after the rollout would examine exactly what it was
supposed to clear.

### The permissions trap that looks like a script error

Running a repository script in the gate image against the production database
needs **two** write permissions at once:

* the ssh user for `git fetch` / `git checkout`,
* the container (uid 10001) for `packages/*/dist`.

A `chown -R 10001` first blocks the first, no `chown` blocks the second — and
**both failures look like an error in the script**. On the first production
host, two audit runs went against *old* code because the `git checkout` had
silently failed and the output still looked plausible.

The way that works:

```bash
K=/tmp/vorschicht-candidate
sudo rm -rf "$K"
git clone --quiet --no-local /opt/vorschicht "$K"   # --no-local, see below
cd "$K" && git remote set-url origin <your-origin-url>
git fetch --quiet origin main && git checkout --quiet <sha>
sudo chown -R 10001:10001 "$K"                      # only after that
```

**`--no-local` is not a detail.** A `git clone --shared` places the objects via
`.git/objects/info/alternates` **outside** the container; inside, `git log`
then fails, the audit's candidate pool is empty, and it would — without the
guard since built in — deliver a verdict that "would have been
indistinguishable from a genuine clearance". That was a `coverage_gap` of the
audit **on itself**.

---

## The weekly report does not arrive by mail — that is not a defect

§16's weekly report is generated on Mondays at 07:00 Europe/Vienna by itself in
the daemon's tick (`apps/orchestrator/src/report-pass.ts`), archived in
`reports` and readable via the dashboard.

**It is not sent** as long as no `SMTP_HOST` is set in the `.env`. That is a
deliberate decision and not a gap: a pass that builds a mail and silently
discards it would look from the outside like one that delivered. The same
applies to A13's reminder after 24 hours and the daily digest — they are silent
without SMTP, and P0 cards can sit for days without a mail ever arriving.

The log shows the run like this:

```
Weekly report for 2026-08-10 to 2026-08-17 generated and archived
(3726 characters). Not delivered — §16's dispatch is its own seam
and needs SMTP.
```

And the headline numbers can be cross-checked — **differently**, not a second
time:

```bash
node infra/scripts/check-kennzahlen.mjs --von <ISO> --bis <ISO>
```

`MetricsService` counts with `count(*) FILTER` in SQL, in one query for all
four throughput numbers; the script fetches raw rows, one query per kind, and
counts in JavaScript. Only the data source is shared. Exit 0/1/**2** as
everywhere, and an empty window ends with 2 instead of 0 — all numbers would
then be trivially equal, and that is no confirmation. The run also says how
many of the numbers it **really** recomputed. To run it against the production
database from the build machine, use `infra/scripts/kennzahlen-remote.sh
--host <ssh-host> -- --von <ISO> --bis <ISO>`, which opens an SSH tunnel and
brings the data to the code instead of building in the production tree.

---

## Two data sets, and how to tell them apart

**There are two Vorschicht databases as soon as you run the stack locally as
well, and an agent has already read the wrong one** and reported a limit event
that does not exist. That is the reason for this section.

| | Production host | Build machine (local) |
|---|---|---|
| Container | `vorschicht-db-1` on the host | `vorschicht-db-1` **here** |
| `event_log` | tens of thousands of rows | a few thousand |
| Internal audits | all runs, all findings, the operator's inbox | none |

Both containers have the same name — that is the trap. The only difference is
**on which host** the command runs:

```bash
# production (always over ssh, never locally):
ssh <host> 'docker exec vorschicht-db-1 psql -U vorschicht -d vorschicht -At -c "select count(*) from event_log"'

# local — answers only while the local stack is running:
docker exec vorschicht-db-1 psql -U vorschicht -d vorschicht -At -c "select count(*) from event_log"
```

If you halt the local stack, use `docker stop` — not `down`, not `-v` — so data
and volumes stay **untouched**. Starting it again:

```bash
docker start vorschicht-db-1 vorschicht-app-1 vorschicht-orchestrator-1 vorschicht-backup-1
```

`docker compose ... stop` does **not** work for this out of the box: the
Compose file interpolates `POSTGRES_PASSWORD` from the `.env` and otherwise
aborts before touching anything. Going by container name always works.

A third container, `vorschicht-audit-db`, does **not** belong to the stack: it
is the persistent audit database from `infra/scripts/audit-db.sh` (A146.4) and
may keep running.

**Why a second data set exists at all:** the build machine needed one while the
production host carried nothing yet. Once the production host carries
everything, every question about *operations* — budget, audits, escalations,
metrics — is asked there. The local data set is only for integration tests,
and those create their own database per suite anyway (A129.2).

---

## `pnpm gate` does not run on the build machine

```bash
infra/scripts/gate-in-container.sh              # all twelve steps, ~6 min
infra/scripts/gate-in-container.sh --only=lint  # single steps
infra/scripts/in-container.sh <command>         # anything in the same environment
```

On Windows **not a single** step starts: `gate.mjs` spawns with
`shell: false`, and Windows will run neither `pnpm.cmd` nor a `.sh` that way.
On top of that, around 27 tests fail there on POSIX file permissions and path
separators — and those assure §6.6 and §19, so they are meant to stay POSIX
(A127).

Two traps: `--only=<step>` does **not** build `packages/*/dist` first, tests
then report "Failed to resolve entry for package", and `--only=e2e` ends with
**1** instead of 2 — i.e. a finding where nothing was checked. And: run it
again after the last documentation change, not before; the twelfth step reads
the documents named in `infra/scripts/gate-doku.mjs` against `CLAUDE.md` and
holds not only the gate count but also the phase sentence ("Phases 0–N closed",
"Phase N under way") and every named gate id. *(A finding is fixed at **every**
place it stands, otherwise it migrates — this document once carried a stale
"two files" here that had been corrected elsewhere.)*

---

# §12 — the rollout

From here on this is about what the studio does **with other projects**.
Putting Vorschicht onto its own host is something else: **installation** is in
the README, the **rollout of a new version** in the section "Rolling out
Vorschicht itself" above.

## What a deployment does, in this order

It is not triggered by the merge itself. The merge queue sets the task to
`deploying` and writes the merged commit as `baseShaAfter` into the state
transition; the scheduler's next tick picks it up there — **before** the merge
phase, because a task in `deploying` is further along §9's chain than anything
else the tick can see. At most one rollout per project and tick, and the tick
waits for it (two rollouts of the same project would overtake each other on
the same machine).

A task that sits on `deploying` but whose state transition names **no** commit
is not deployed but quarantined: "we do not know which version this is" and
"we deploy HEAD" are the same sentence only for a system that has decided not
to look.

Then, in `DeployService.deploy()`:

| # | Step | What remains |
|---|---|---|
| 1 | Read method. `none` or no target registered | nothing — outcome `unsupported`, quarantine |
| 2 | Ask the guardian (§7.2) | nothing — outcome `deferred`, see below |
| 3 | A24: non-backward-compatible migration? | card `migration_stop`, task `needs_decision` |
| 4 | A12: self-deploy? | card `self_deploy`, task `needs_decision` |
| 5 | Create record | `deployment_events` `started` (`seq` 0) |
| 6 | `target.prepare` — build and name | no event yet; the artifact comes into being |
| 7 | `migrateCommand`, if configured | `migrated` with output. Red ⇒ `failed`, **nothing was swapped** |
| 8 | `target.swap` — the swap | `swapped` with the artifact identifier |
| 9 | Poll health URL until green or time limit | `health_checked` with verdict **and** reason |
| 10 | `smokeCommand`, if configured | `smoke_checked`. Red ⇒ rollback as in 9 |
| 11 | `target.prune(keep)` — old releases removed (A11: five) | — |
| 12 | Done | `succeeded`, plus `deploy.succeeded` in `event_log` (on a rollback `deploy.rolled_back`, on a failure with no way back `deploy.failed` since A143 — the third kind was missing, and without it §16's weekly report would have reported "0 rollbacks" while production served the broken version), task `done` |

The order of 7 and 8 is **not a parameter** (A24). A rollback restores the
*code* of the previous version and cannot undo what a migration did to the
data — so the migration is the one step whose failure has to happen while
nothing has been swapped yet.

Healthy means: HTTP status 200–299 on `healthUrl`, without following
redirects, 10 s limit per request. Defaults: `healthTimeoutMs` 90 000,
`healthIntervalMs` 3 000, `keep` 5. The first request happens immediately, not
after an interval.

`deployment_events` is append-only (trigger, also against `TRUNCATE`);
`deployments` is the view over it. Nothing is summarised at the end — every
step writes as it passes, so a rollout that crashed midway leaves behind how
far it got.

```bash
docker compose ... exec db psql -U vorschicht -d vorschicht -c "
  SELECT started_at, sha, method, artifact, outcome, health_ok, duration_ms
  FROM deployments ORDER BY started_at DESC LIMIT 10;"
```

**`artifact` is the release that was *swapped in* — not the one serving
now.** On a `rolled_back` row it therefore holds the broken one, even though it
sits right next to `outcome` and reads like "this is running". Where the
rollback went is stated only by the payload of the `rolled_back` event (the
query for that is in the next section). For a rollout that failed before the
swap, the column is `NULL` — then nothing really was swapped.

And the whole course of a single one:

```bash
docker compose ... exec db psql -U vorschicht -d vorschicht -c "
  SELECT seq, kind, occurred_at, payload
  FROM deployment_events WHERE deployment_id = '<uuid>' ORDER BY seq;"
```

## Reading a rollback — the three-in-the-morning query

`deployments.outcome` knows exactly four values, and **three of them are easily
misread**:

| `outcome` | What really happened |
|---|---|
| `succeeded` | deployed, healthy, old releases pruned |
| `rolled_back` | the new release's health check was red, the previous one was **swapped back** — whether *that* became healthy is **not** in this column |
| `failed` | **nothing was swapped back.** Three ways here, see below |
| `NULL` | running right now — or crashed midway. `last_step` says how far |

**Trap 1: `health_ok` does not answer whether the rollback became healthy.**
`health_checked` is written exactly once, for the *new* release. On a
rolled-back row it is therefore always `false`, and it means the broken
release. The re-check *after* swapping back is in `healthAfter` in the payload
of the `rolled_back` event:

```bash
docker compose ... exec db psql -U vorschicht -d vorschicht -c "
  SELECT deployment_id,
         payload #>> '{healthAfter,ok}'     AS rollback_healthy,
         payload #>> '{healthAfter,detail}' AS rollback_detail,
         payload ->> 'rolledBackTo'         AS rolled_back_to_deployment,
         payload ->> 'artifact'             AS rolled_back_to_artifact,
         payload ->> 'problem'              AS trigger
  FROM deployment_events WHERE kind = 'rolled_back'
  ORDER BY occurred_at DESC LIMIT 5;"
```

`rollback_healthy = true` means: production is serving again, on the named
artifact. `false` means: **the state of production is unclear**, and that is
the case you get up for.

**Trap 2: `rollback_failed` appears nowhere in the database.** The `CHECK` on
`deployment_events.kind` does not know the value, so the view cannot deliver
it. It exists only as a return value in the process and shows up in the
orchestrator's log line `Rollout (§12)` (`outcome: "rollback_failed"`).
Durably, the two cases are distinguishable via `healthAfter.ok` above — and
via the card that is created, **by its urgency and by its text**: `rolled_back`
(rolled back and healthy again) carries **P1**, `rollback_failed` carries
**P0**. Both hang on the same quantity: `service.ts` has
`outcome: after.ok ? 'rolled_back' : 'rollback_failed'` and
`urgency: after.ok ? 'P1' : 'P0'`.

*(This rule has changed direction twice — see the boxed history below. For a
reader at three in the morning, a document that says the opposite of what is
on the screen is the most expensive kind of error, which is why the history is
kept here rather than deleted.)*

**Trap 3: `failed` is the more unpleasant state, not `rolled_back`.** There
are three ways there, and only with the first is production certainly
untouched:

1. the migration failed **before** the swap — the old version keeps serving
   unchanged, and the state of the data depends on how far the migration got;
2. the rollout crashed midway — `last_step` says where;
3. the health check was red **and there was no earlier healthy release** to
   fall back to. That is typically a project's first rollout, and here **the
   broken release keeps serving**.

```bash
docker compose ... exec db psql -U vorschicht -d vorschicht -c "
  SELECT id, sha, method, artifact, last_step, health_ok, problem, started_at
  FROM deployments WHERE outcome = 'failed' OR outcome IS NULL
  ORDER BY started_at DESC LIMIT 10;"
```

In all three cases the task is set to `red` and takes §9's red path; on a
rollback likewise. That is the answer to "what happens to the change" and not
to "what is running in production" — the two questions are separate and are
answered separately.

**And in all three cases a card is created since A93** (source
`deploy_failed`), whose urgency distinguishes exactly the three above:
migration failed before the swap, old version serving unchanged → **P1**;
crashed midway (unclear) or no healthy predecessor release (the broken one
serving) → **P0**. In code: `urgency: serving === 'previous' ? 'P1' : 'P0'`.

Before that there was **no** card here at all: task red, scheduler reported
"rolled back", nobody notified — although §12 already demands a card for a
genuine rollback and this is the worse case. Since A143 a row is additionally
written to the event log (`deploy.failed`), without which §16's weekly report
would have reported "0 rollbacks" while production served the broken version.

**How it announces itself.** A rollback creates a card in the inbox, source
`rollback`. The urgency is **P0 — unless the rollback itself came back healthy,
then P1** (§12 as revised, A133). Whether it became healthy is stated
**additionally** in the text and not only in the urgency: if it did not, the
first sentence is "The rollback did not become healthy either", and the
recommendation flips to "look for yourself". Both are decided by the same
quantity, `healthAfter.ok`. The card additionally goes out over the ntfy topic
`vorschicht-inbox`.

> *(This rule has changed direction twice, and anyone reading an old trace
> should know which version applied at the time. **Initially:** P1 in the
> healthy case — justified with §15's reading of P0, production being back in
> service. A defensible judgement that was not the build's to make, because
> §12 then said "escalate with full logs (P0 inbox item + ntfy)" without
> distinction; withdrawn in A96. **Then:** P0 in both cases. **Since A133:**
> P1 again in the healthy case — because §12 was changed, the distinction is
> now in its wording and the implementation follows it. The difference between
> the first and the third version is not the outcome but who decided.
> Incidentally, a demonstration of how fast an operations document goes wrong:
> this section was correct at 10:22 one morning and wrong at 11:12
> (`68638bd` versus `ed442b8`), and stayed so for seven days.)*

*Deviation, explicitly recorded:* §16 assigns rollbacks to the channel
`vorschicht-alerts`; it is built as an inbox card, and `alerts` today carries
auth incidents, start-up problems and the watchdog. Anyone waiting on `alerts`
for a rollback alert waits in vain.

## "Nothing gets deployed" — three harmless reasons and one bad one

The difference is visible from the outside if you know what to look for: the
harmless cases create **no row in `deployments`**, because the refusal happens
before the first artifact.

**1 — The guardian (§7.2).** Outside `normal` no rollout starts. Outcome
`deferred`: nothing touched, no record, no backoff, no counter, no message. The
next tick simply asks again — a backoff would push the rollout minutes past
the moment the window reopens.

```bash
docker compose ... exec db psql -U vorschicht -d vorschicht -c "
  SELECT state, reason, occurred_at FROM guardian_events
  ORDER BY id DESC LIMIT 5;"
```

**2 — A12, the self-deploy.** Only for the self-managed project. The task sits
on `needs_decision`, there is an open card of source `self_deploy`, and the
question is **not** asked again on every tick.

**3 — A24, the non-backward-compatible migration.** Card of source
`migration_stop`, P1. What is read for this is `gate.migration_review` from the
`event_log`, which the migration-review gate has written since Phase 3. **A
missing review is not a stop** — otherwise every rollout of every project that
never enabled this gate would park.

Cases 2 and 3 are checked in this order: A24 first, A12 after.

```bash
docker compose ... exec db psql -U vorschicht -d vorschicht -c "
  SELECT number, source, urgency, question, raised_at
  FROM escalations WHERE state = 'open' ORDER BY raised_at DESC;"
```

**4 — the bad case: quarantine.** A task sits on `deploying`, but the scheduler
has set it aside and no longer touches it. Three triggers: no commit in the
state transition, no deploy target for the configured method (`unsupported`),
or the project no longer exists. The quarantine lives **in the process's
memory** — a restart with corrected code picks the task up again — but it is
logged:

```bash
docker compose ... exec db psql -U vorschicht -d vorschicht -c "
  SELECT occurred_at, task_id, payload ->> 'reason' AS reason
  FROM event_log WHERE kind = 'scheduler.defect'
  ORDER BY id DESC LIMIT 10;"
```

To rule out all four at once, start here — tasks that are standing still, and
whether a record exists for them:

```bash
docker compose ... exec db psql -U vorschicht -d vorschicht -c "
  SELECT t.id, t.title, t.state, d.id AS deployment, d.outcome
  FROM tasks t LEFT JOIN deployments d ON d.task_id = t.id
  WHERE t.state IN ('deploying', 'needs_decision')
  ORDER BY t.updated_at DESC;"
```

## Answering an approval, and what happens next

In the dashboard under **Inbox**, or directly via the permalink
`/posteingang/<number>` that the ntfy message also carries. Choose an option or
answer freely — both are recorded, but see the box below: for a rollout it
**must** be the option.

Afterwards, in the next tick and still before the merge phase: the scheduler
sees the answered card, and because the task was parked out of `deploying`, it
does **not** continue it through the dev chain (§6.4 needs a session for that,
and these two cards have none) but via `tasks.resume` — back to `deploying`.
The rollout phase of the **same** tick then picks it up. As a rule, the rollout
therefore runs seconds after your answer.

> **Answered is not approved.** Both cards release the rollout only if you
> choose the option that means it — on the self-deploy card that is
> **"Ausrollen"** (deploy), on A24's migration card **"Trotzdem ausrollen"**
> (deploy anyway). Everything else halts: the respective other option, and
> also a pure free-text answer. That is deliberate — reading out of "yes go,
> but only after the backup" whether you agreed would be guesswork on exactly
> these two questions, and §15 always allows free text. So if you want to
> answer freely *and* deploy: choose the option first.
>
> *(It was once the other way round and wrong: only **that** an answer existed
> was checked. On the migration card, the **recommended** option "Wait — I
> will make the migration backward-compatible first" thereby released the
> rollout. Reported to the build as a finding and fixed there — A93, A97.)*

## Where the release history is

Dashboard → **Projects** → the project (`/projekte/<slug>`), section
**"Releases (§12)"**. The last 20 rollouts, newest first, with commit, method,
artifact, outcome, duration and start time. On a rollback the outcome column
names **where** it rolled back to; if the target lies outside the last 20, it
says so instead of printing an identifier as the answer.

Three sentences there mean three different things, and the first is the one
otherwise misread:

- *"This server reads no deployments"* — this process has no `DeployRecords`.
  The list would be empty without saying anything about the project.
- *"The release history does not match the agreed format"* — the answer arrived
  and could not be read. An error, not an empty state.
- *"Nothing has been deployed for this project yet"* — checked and really empty.
