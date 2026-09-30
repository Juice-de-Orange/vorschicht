/**
 * Environment configuration, validated at the boundary (A4: zod at all
 * boundaries).
 *
 * Two rules this module enforces that are easy to lose later:
 *
 *   1. **No API key, ever.** §2 makes this a hard rule, not a preference. The
 *      loader refuses to start if `ANTHROPIC_API_KEY` is present in the
 *      environment at all — not because it would necessarily be used, but
 *      because its mere presence means someone has arranged for it to be
 *      usable, and this system must fail loudly at that moment rather than
 *      quietly bill the operator later.
 *   2. **Secrets are never logged.** `redact()` exists so that dumping the
 *      config in a diagnostic is safe by construction rather than by care.
 */
import { z } from 'zod';

const nonEmpty = z.string().min(1);

const configShape = z.object({
  // --- paths (A2/A33) ---
  projectsRoot: nonEmpty.default('/opt'),
  dataRoot: nonEmpty.default('/srv/vorschicht'),
  /**
   * Where task worktrees live (§10). Defaults to `<dataRoot>/worktrees` — kept
   * *outside* the projects root on purpose: a worktree under `/opt` would look
   * like a project to onboarding, to the disk-usage report and to anyone
   * reading the host. The commits live in the project repository either way,
   * which is why this directory is disposable and not part of the backup.
   */
  worktreesRoot: nonEmpty.optional(),
  /**
   * Where session transcripts are archived (§6.2, §18). `<dataRoot>/transcripts`.
   *
   * A volume, and in the backup (A14): §18 puts transcripts there deliberately,
   * because principle 4's traceability chain has to survive a disk loss too.
   */
  transcriptsRoot: nonEmpty.optional(),
  /**
   * Where §13's vault stores uploaded files. `<dataRoot>/docs`.
   *
   * A volume, and in the backup (A14) — §18 names the docs volume explicitly,
   * because a `document_versions` row is a pointer and the bytes it points at
   * are the document. The **app** writes here, which is new: until §13 the docs
   * volume was mounted by the orchestrator and the backup sidecar only. Both
   * compose files therefore mount it into `app` as well, and they have to agree
   * about *which* filesystem — on the production host the overlay replaces the named volume
   * with a host bind, so a service that got the mount in only one of the two
   * files would store uploads on a disk the vault's readers cannot see (an
   * `app`-shaped instance of exactly the "row without bytes" this subsystem
   * refuses one layer down).
   */
  docsRoot: nonEmpty.optional(),

  // --- database ---
  databaseUrl: nonEmpty,

  // --- app / ingress (A1) ---
  appBind: nonEmpty.default('127.0.0.1'),
  appPort: z.coerce.number().int().min(1).max(65535).default(8420),
  publicOrigin: z.url(),
  webauthnRpId: nonEmpty,
  webauthnRpName: nonEmpty.default('Vorschicht'),
  sessionSecret: z.string().min(32, 'SESSION_SECRET braucht mindestens 32 Zeichen'),

  // --- Claude Code access (§6.1) ---
  claudeOauthToken: z.string().startsWith('sk-ant-oat', 'Nur Abo-Token, kein API-Key (§2)'),
  claudeCliVersion: nonEmpty,
  /**
   * Where the per-role `settings.<role>.json` files live (§6.2).
   *
   * They carry the §6.6 containment hooks and are passed with `--settings`.
   * Baked into the image at `/app/claude`, overridable so that a test can point
   * a session at a fixture set without rebuilding.
   */
  roleSettingsDir: nonEmpty.default('/app/claude'),
  /**
   * Entry point of the internal `vorschicht` MCP server (§6.2, §13).
   *
   * The `--mcp-config` document itself is written **per run** — it carries the
   * task id, which is what binds a session to exactly one task — so what is
   * configured here is the server, not the document. Baked into the image;
   * overridable so a test can point at a build directory.
   *
   * Optional on purpose: an unset value means sessions spawn without MCP rather
   * than with a config file naming a script that does not exist, which is the
   * difference between a role that cannot look up its task and a run that dies
   * at startup.
   */
  mcpServerEntry: z.string().optional(),
  /**
   * The §6.6 containment hook, spawned by the CLI on every tool call.
   *
   * Not optional and with no default that could be wrong: the daemon writes the
   * role settings from this path at start-up and every session's write
   * containment hangs off it. Baked into the image and asserted there, so an
   * image that lost it fails the build rather than running a night of
   * uncontained sessions.
   */
  hookEntry: nonEmpty.default('/app/node_modules/@vorschicht/core/dist/hook-entry.js'),
  /**
   * Scratch directory for per-run files, `<dataRoot>/runs` by default.
   *
   * Deliberately not a volume: everything in it belongs to a run in flight, and
   * a restart ends every run it could belong to.
   */
  runsRoot: nonEmpty.optional(),

  // --- notifications (§16) ---
  ntfyServer: z.url(),
  ntfyToken: nonEmpty,
  ntfyTopicInbox: nonEmpty.default('vorschicht-inbox'),
  ntfyTopicAlerts: nonEmpty.default('vorschicht-alerts'),
  ntfyTopicInfo: nonEmpty.default('vorschicht-info'),

  /**
   * SMTP (§16: reminders, digests, weekly report).
   *
   * Every field is optional, and that is the decision rather than an oversight:
   * `.env.example` ships `SMTP_USER`/`SMTP_PASSWORD` empty, so an installation
   * that has not set mail up yet is the ordinary first state. Making these
   * required would mean a studio that refuses to start because it cannot send
   * an e-mail nobody is waiting for — the notifications that carry real urgency
   * go over ntfy, which *is* required. `createMailer` turns an incomplete set
   * into a `DisabledMailer` that says which variable is missing.
   */
  smtpHost: z.string().min(1).optional(),
  smtpPort: z.coerce.number().int().min(1).max(65535).default(465),
  smtpSecure: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  smtpUser: z.string().optional(),
  smtpPassword: z.string().optional(),
  /** `Vorschicht <vorschicht@…>` — the envelope sender and the From header. */
  smtpFrom: z.string().min(1).optional(),
  /**
   * Where A13's reminders, digests and §16's weekly report go: The operator.
   *
   * Its own variable rather than a reuse of `smtpFrom`, because "who this studio
   * sends as" and "who reads it" are different facts that happen to look alike
   * on one installation.
   */
  reportRecipient: z.email().optional(),

  // --- operations ---
  /**
   * §18's backup record: written by the sidecar, read by the daemon.
   *
   * The two processes meet on a file rather than on the database, and that is a
   * rule rather than a convenience. `EventLog.append` is the only sanctioned
   * way into the event log, it lives in a Node package the `postgres:alpine`
   * sidecar does not have, and that sidecar *does* hold database credentials —
   * which is precisely why it must not write rows of its own. So
   * `backup-run.sh` leaves `.last-result` and `runBackupPass` reports it.
   *
   * The default is the container path `infra/docker-compose.yml` mounts the
   * backups volume at, and the two have to agree. Nothing derives it from
   * `dataRoot`: the backups volume is deliberately not under `/data`, because
   * the daemon mounts it read-only and everything under `/data` it writes.
   */
  backupResultPath: nonEmpty.default('/backups/.last-result'),

  /**
   * gitleaks' rule file for §6.6's nightly transcript scan (A105).
   *
   * Passed rather than discovered, and that distinction has been measured: the
   * transcript archive is not a git tree, so gitleaks finds no config beside it
   * and falls back to its defaults — under which A104's mutation M2 showed a
   * `sk-ant-oat` token in a transcript going **undetected**. The default is
   * where `Dockerfile.orchestrator` copies the repository's own
   * `.gitleaks.toml`, so the nightly scan and the merge gate decide by the same
   * rules; if the file is absent the scan reports `infra` and never `clean`
   * (A104.3/A105.6), which is the one behaviour that keeps a missing file from
   * reading as a clean archive.
   */
  gitleaksConfigPath: nonEmpty.default('/app/.gitleaks.toml'),

  /**
   * §6.0's billing channels and A27's CLI release channel — **no default**.
   *
   * Both are deliberately empty until an operator names them, and the radar
   * reports an unconfigured channel as an *unchecked surface* rather than as a
   * clean scan. The reason is that neither URL is one this project can state
   * with confidence: the CLI is installed from `claude.ai/install.sh`
   * (`Dockerfile.orchestrator`), not from a registry whose document shape could
   * be pinned, and §6.0's announcements have lived on help-center pages that
   * move. A guessed URL would 404 every six hours, and a 404 that reads as
   * "nothing announced" is the failure A104.4 measured — for the project's own
   * #1 external risk. The npm registry is the one channel that *is* defaulted,
   * in `HttpRadarFeeds`, because its shape is nameable.
   *
   * Comma-separated, and blank counts as unset for the reason A82.1 gives.
   */
  radarBillingUrls: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  radarCliUrl: z.url().nullable().default(null),
  /** Overridable so a test or a mirror can point the dependency radar elsewhere. */
  radarRegistry: nonEmpty.default('https://registry.npmjs.org'),

  timezone: nonEmpty.default('Europe/Vienna'),
  planProfile: z.enum(['max_20x', 'max_5x']).default('max_20x'),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

/**
 * Derived paths are resolved here rather than at the use site, so that every
 * component gets the same answer and `dataRoot` stays the single knob.
 */
export const configSchema = configShape.transform((config) => ({
  ...config,
  worktreesRoot: config.worktreesRoot ?? `${config.dataRoot}/worktrees`,
  transcriptsRoot: config.transcriptsRoot ?? `${config.dataRoot}/transcripts`,
  docsRoot: config.docsRoot ?? `${config.dataRoot}/docs`,
  runsRoot: config.runsRoot ?? `${config.dataRoot}/runs`,
}));

export type Config = z.infer<typeof configSchema>;

/** Env var names that must never appear, per §2's hard rule. */
export const FORBIDDEN_ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** An unset variable and one set to nothing mean the same thing to this loader. */
function blankToUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const present = FORBIDDEN_ENV_KEYS.filter((key) => {
    const value = env[key];
    return typeof value === 'string' && value.length > 0;
  });
  if (present.length > 0) {
    throw new ConfigError(
      `§2 verbietet API-Key-Zugang. Gefunden: ${present.join(', ')}. ` +
        'Vorschicht startet nicht, solange diese Variablen gesetzt sind.',
      present,
    );
  }

  const parsed = configSchema.safeParse({
    projectsRoot: env.VORSCHICHT_PROJECTS_ROOT,
    dataRoot: env.VORSCHICHT_DATA_ROOT,
    worktreesRoot: env.VORSCHICHT_WORKTREES_ROOT,
    transcriptsRoot: env.VORSCHICHT_TRANSCRIPTS_ROOT,
    docsRoot: env.VORSCHICHT_DOCS_ROOT,
    databaseUrl: env.DATABASE_URL,
    appBind: env.APP_BIND,
    appPort: env.APP_PORT,
    publicOrigin: env.PUBLIC_ORIGIN,
    webauthnRpId: env.WEBAUTHN_RP_ID,
    webauthnRpName: env.WEBAUTHN_RP_NAME,
    sessionSecret: env.SESSION_SECRET,
    claudeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
    claudeCliVersion: env.CLAUDE_CLI_VERSION,
    roleSettingsDir: env.VORSCHICHT_ROLE_SETTINGS_DIR,
    mcpServerEntry: env.VORSCHICHT_MCP_SERVER,
    hookEntry: env.VORSCHICHT_HOOK_ENTRY,
    runsRoot: env.VORSCHICHT_RUNS_ROOT,
    ntfyServer: env.NTFY_SERVER,
    ntfyToken: env.NTFY_TOKEN,
    ntfyTopicInbox: env.NTFY_TOPIC_INBOX,
    ntfyTopicAlerts: env.NTFY_TOPIC_ALERTS,
    ntfyTopicInfo: env.NTFY_TOPIC_INFO,
    // `.env.example` ships these blank, and a blank is "not configured" rather
    // than "the empty string" — without the coercion `REPORT_RECIPIENT=` would
    // fail the address check and a studio with no mail set up would refuse to
    // boot over a notification nobody is waiting for.
    //
    // The two that carry a `.default()` need it just as much, and for a reason
    // that is easy to miss: a default fires on `undefined` and on nothing else.
    // `SMTP_PORT=` would reach `z.coerce.number()` as `Number('')` — zero, below
    // the `.min(1)` — and `SMTP_SECURE=` is not a member of the enum, so a blank
    // line in `.env` produced two validation problems and a daemon that refused
    // to start. A value that is set and wrong still stops the boot (that is the
    // point of validating), but an empty line is an unset variable.
    smtpHost: blankToUndefined(env.SMTP_HOST),
    smtpPort: blankToUndefined(env.SMTP_PORT),
    smtpSecure: blankToUndefined(env.SMTP_SECURE),
    smtpUser: blankToUndefined(env.SMTP_USER),
    smtpPassword: blankToUndefined(env.SMTP_PASSWORD),
    smtpFrom: blankToUndefined(env.SMTP_FROM),
    reportRecipient: blankToUndefined(env.REPORT_RECIPIENT),
    backupResultPath: env.VORSCHICHT_BACKUP_RESULT,
    gitleaksConfigPath: env.VORSCHICHT_GITLEAKS_CONFIG,
    // A82.1: a variable somebody emptied must reach `.default()`, which fires on
    // `undefined` and on nothing else. `radarCliUrl` would otherwise refuse to
    // boot on a blank line, and `radarBillingUrls` would see `''`.
    radarBillingUrls: blankToUndefined(env.VORSCHICHT_RADAR_BILLING_URLS),
    radarCliUrl: blankToUndefined(env.VORSCHICHT_RADAR_CLI_URL),
    radarRegistry: blankToUndefined(env.VORSCHICHT_RADAR_REGISTRY),
    timezone: env.TZ,
    planProfile: env.PLAN_PROFILE,
    logLevel: env.LOG_LEVEL,
  });

  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (i) => `${i.path.join('.') || '<root>'}: ${i.message}`,
    );
    // Name every problem in the message itself, not only in `problems`. This
    // error is read at 3am from a container log where nobody is inspecting
    // exception properties.
    throw new ConfigError(
      `Konfiguration unvollständig oder ungültig (${problems.length} Problem(e)):\n` +
        problems.map((p) => `  • ${p}`).join('\n') +
        '\n  Siehe .env.example.',
      problems,
    );
  }

  return parsed.data;
}

const SECRET_KEYS = new Set<keyof Config>([
  'databaseUrl',
  'sessionSecret',
  'claudeOauthToken',
  'ntfyToken',
  'smtpPassword',
]);

/** A copy of the config that is safe to log, dump or attach to an error report. */
export function redact(config: Config): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      key,
      SECRET_KEYS.has(key as keyof Config) ? '«redacted»' : value,
    ]),
  );
}
