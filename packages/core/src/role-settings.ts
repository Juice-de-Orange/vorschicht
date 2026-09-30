/**
 * The per-role `--settings` documents (§6.2, §6.6) — where containment is armed.
 *
 * §6.2 passes `--settings /app/claude/settings.<role>.json` on every spawn, and
 * §6.6 says what belongs in it: the `PreToolUse` hooks that deny a write outside
 * the worktree ∧ claim set and a read of a credential. This module generates
 * those files and refuses to write one it cannot validate.
 *
 * The validation is not ceremony. In `-p` mode a settings file that fails the
 * CLI's own validation is ignored **silently** — no warning in the stream, no
 * non-zero exit, just a session running with no hooks at all. That is the worst
 * failure shape this system has: containment that looks armed and is not. So
 * the documents are generated rather than hand-written, checked against a zod
 * schema before they are written and again when the daemon starts, and the
 * runner additionally requires evidence at runtime that a hook actually fired
 * (`ContainmentMonitor`). Three checks for one property, because the property
 * fails quietly.
 *
 * **What is deliberately not in these files: `permissions.deny` rules.**
 * Claude Code can also refuse tools by pattern from settings, and a second
 * independent mechanism is tempting. It was left out for the reason above: an
 * unrecognised key risks the whole document being discarded, taking the hooks
 * with it, and the benefit would be a layer whose effect we cannot prove the
 * way `check-hook-containment.mjs` proves the hook. A safeguard that is not
 * demonstrated is not a safeguard (§0.3).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { AGENT_PROFILES, type ProfileId, roleSettingsPath } from './profiles/index.js';

/**
 * Hook timeout in seconds.
 *
 * The hook itself costs ~50 ms (bare Node startup plus a one-millisecond
 * import). Ten seconds is not a budget, it is a margin for a host under load —
 * and it matters which way the margin errs: a hook that times out is reported
 * as an error, and an errored `PreToolUse` hook lets the tool proceed.
 */
const HOOK_TIMEOUT_SECONDS = 10;

const hookCommandSchema = z.object({
  type: z.literal('command'),
  command: z.string().min(1),
  timeout: z.number().int().positive(),
});

const hookMatcherSchema = z.object({
  matcher: z.string().min(1),
  hooks: z.array(hookCommandSchema).min(1),
});

/**
 * The shape the CLI is handed.
 *
 * `.strict()` on purpose: an extra key is how a document ends up rejected as a
 * whole, and it is better to fail here — in a build, with a stack trace — than
 * in a session at 3am that quietly runs without hooks.
 */
export const roleSettingsSchema = z
  .object({
    hooks: z
      .object({
        SessionStart: z.array(hookMatcherSchema).min(1),
        PreToolUse: z.array(hookMatcherSchema).min(1),
      })
      .strict(),
  })
  .strict();

export type RoleSettings = z.infer<typeof roleSettingsSchema>;

export class RoleSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleSettingsError';
  }
}

export interface RoleSettingsInput {
  /** Absolute path of the compiled hook, e.g. `/app/.../dist/hook-entry.js`. */
  hookEntry: string;
  /** The interpreter. `node` unless a test needs otherwise. */
  command?: string;
}

/**
 * Build one role's settings document.
 *
 * The same document for every role today, and generated per role anyway,
 * because §6.2 names the file per role and Phase 6's staff profiles will want
 * different hooks — a Legal session has no worktree to contain and no reason to
 * pay the check on every read.
 *
 * The command is a **shell** line: the CLI expands `$VAR` in it (verified). So
 * a path containing whitespace or a shell metacharacter would be split or
 * interpreted, and the hook would silently never run. Refused rather than
 * quoted, because a quoting scheme is one more thing that can be subtly wrong.
 */
export function buildRoleSettings(input: RoleSettingsInput): RoleSettings {
  const command = input.command ?? 'node';
  for (const [label, value] of [
    ['Hook-Pfad', input.hookEntry],
    ['Interpreter', command],
  ] as const) {
    if (!value.trim()) throw new RoleSettingsError(`${label} fehlt.`);
    if (/[\s"'`$\\;&|<>()]/.test(value)) {
      throw new RoleSettingsError(
        `${label} "${value}" enthält Zeichen, die die Shell auswertet. Die Hook-Zeile ` +
          'wird von der CLI durch eine Shell geschickt; ein solcher Pfad würde ' +
          'zerteilt und der Hook liefe nie — still, wie §6.6 es beschreibt.',
      );
    }
  }
  if (!input.hookEntry.startsWith('/')) {
    throw new RoleSettingsError(
      `Hook-Pfad "${input.hookEntry}" ist nicht absolut. Der Hook läuft im ` +
        'Arbeitsverzeichnis der Sitzung — also im Worktree der Aufgabe.',
    );
  }

  const entry = (mode: string) => ({
    matcher: '*',
    hooks: [
      {
        type: 'command' as const,
        command: `${command} ${input.hookEntry} ${mode}`.trim(),
        timeout: HOOK_TIMEOUT_SECONDS,
      },
    ],
  });

  return roleSettingsSchema.parse({
    hooks: {
      // Liveness (§6.6): reported by the CLI even without --include-hook-events,
      // so "did containment load at all" is answerable before a turn is spent.
      SessionStart: [entry('session-start')],
      // `*` matches every tool, not only the four that mutate. That is what
      // makes an unknown tool the hook has never heard of still get a decision
      // rather than a free pass (see `isMutating`).
      PreToolUse: [entry('pre-tool-use')],
    },
  });
}

/**
 * Write `settings.<role>.json` for every profile and return the paths.
 *
 * Called at daemon start rather than baked into the image: the hook path is
 * configuration, and a file generated from the same code that reads it cannot
 * drift from it.
 */
export async function writeRoleSettings(
  dir: string,
  input: RoleSettingsInput,
): Promise<Record<ProfileId, string>> {
  const document = buildRoleSettings(input);
  const body = `${JSON.stringify(document, null, 2)}\n`;
  await mkdir(dir, { recursive: true });

  const written = {} as Record<ProfileId, string>;
  for (const id of Object.keys(AGENT_PROFILES) as ProfileId[]) {
    const path = roleSettingsPath(dir, id);
    await writeFile(path, body, { mode: 0o644 });
    written[id] = path;
  }
  return written;
}

/**
 * Re-read every role's settings and confirm it is still what we would write.
 *
 * The daemon-start half of the three checks named in the file header. It
 * compares content rather than merely validating shape, because the failure it
 * exists to catch is a *stale* file — a container that kept an old
 * `/app/claude` across an upgrade would otherwise point every session's hook at
 * a path that no longer exists, and the CLI would report that as an errored
 * hook, which lets the tool run.
 */
export async function verifyRoleSettings(dir: string, input: RoleSettingsInput): Promise<void> {
  const expected = JSON.stringify(buildRoleSettings(input));
  const problems: string[] = [];

  for (const id of Object.keys(AGENT_PROFILES) as ProfileId[]) {
    const path = roleSettingsPath(dir, id);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      problems.push(`${path}: fehlt`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      problems.push(`${path}: kein gültiges JSON`);
      continue;
    }
    const result = roleSettingsSchema.safeParse(parsed);
    if (!result.success) {
      problems.push(`${path}: ${result.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    if (JSON.stringify(result.data) !== expected) {
      problems.push(`${path}: Inhalt weicht von der erzeugten Fassung ab`);
    }
  }

  if (problems.length > 0) {
    throw new RoleSettingsError(
      'Containment-Einstellungen (§6.6) sind nicht in Ordnung — eine ungültige ' +
        'Settings-Datei wird im -p-Modus stillschweigend ignoriert, die Sitzung liefe ' +
        `dann ohne Schreibgrenze:\n${problems.map((p) => `  • ${p}`).join('\n')}`,
    );
  }
}
