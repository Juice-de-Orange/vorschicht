import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROFILE_IDS, roleSettingsPath } from './profiles/index.js';
import {
  buildRoleSettings,
  RoleSettingsError,
  roleSettingsSchema,
  verifyRoleSettings,
  writeRoleSettings,
} from './role-settings.js';

const HOOK = '/app/node_modules/@vorschicht/core/dist/hook-entry.js';

describe('buildRoleSettings', () => {
  it('registers both hook events §6.6 relies on', () => {
    const settings = buildRoleSettings({ hookEntry: HOOK });
    expect(Object.keys(settings.hooks).sort()).toEqual(['PreToolUse', 'SessionStart']);
    expect(settings.hooks.PreToolUse[0]?.hooks[0]?.command).toBe(`node ${HOOK} pre-tool-use`);
    expect(settings.hooks.SessionStart[0]?.hooks[0]?.command).toBe(`node ${HOOK} session-start`);
  });

  it('matches every tool, not only the four that mutate', () => {
    // A matcher listing tool names would give a free pass to any tool the CLI
    // grows next; the decision about what a tool does belongs in the hook.
    for (const entry of buildRoleSettings({ hookEntry: HOOK }).hooks.PreToolUse) {
      expect(entry.matcher).toBe('*');
    }
  });

  it('gives every hook a timeout — a hook that hangs is a hook that fails open', () => {
    for (const group of Object.values(buildRoleSettings({ hookEntry: HOOK }).hooks)) {
      for (const entry of group) {
        for (const hook of entry.hooks) expect(hook.timeout).toBeGreaterThan(0);
      }
    }
  });

  it('refuses a path the shell would take apart', () => {
    // The CLI runs the command line through a shell (verified against the
    // pinned CLI: `$VAR` expands). A split path means a hook that never runs —
    // silently, which is the failure mode §6.6 warns about.
    for (const bad of [
      '/app/my hooks/hook-entry.js',
      '/app/$HOME/hook.js',
      '/app/hook.js; rm -rf /',
      '/app/hook`whoami`.js',
    ]) {
      expect(() => buildRoleSettings({ hookEntry: bad }), bad).toThrow(RoleSettingsError);
    }
  });

  it('refuses a relative path — the hook runs inside the session worktree', () => {
    expect(() => buildRoleSettings({ hookEntry: 'dist/hook-entry.js' })).toThrow(RoleSettingsError);
  });

  it('rejects a document with an unknown key', () => {
    // Strict on purpose: an unrecognised key is how the whole document ends up
    // discarded, taking the hooks with it.
    expect(
      roleSettingsSchema.safeParse({ hooks: { SessionStart: [], PreToolUse: [] }, extra: 1 })
        .success,
    ).toBe(false);
  });
});

describe('writeRoleSettings / verifyRoleSettings', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vorschicht-settings-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes one file per profile, where §6.2 says --settings will look', async () => {
    const written = await writeRoleSettings(dir, { hookEntry: HOOK });
    for (const id of PROFILE_IDS) {
      expect(written[id]).toBe(roleSettingsPath(dir, id));
      expect(JSON.parse(readFileSync(written[id], 'utf8')).hooks.PreToolUse).toBeTruthy();
    }
  });

  it('accepts what it just wrote', async () => {
    await writeRoleSettings(dir, { hookEntry: HOOK });
    await expect(verifyRoleSettings(dir, { hookEntry: HOOK })).resolves.toBeUndefined();
  });

  it('refuses a missing file', async () => {
    await expect(verifyRoleSettings(dir, { hookEntry: HOOK })).rejects.toThrow(/fehlt/);
  });

  it('refuses a file that is no longer JSON', async () => {
    await writeRoleSettings(dir, { hookEntry: HOOK });
    writeFileSync(roleSettingsPath(dir, 'coder'), '{ broken');
    await expect(verifyRoleSettings(dir, { hookEntry: HOOK })).rejects.toThrow(
      /kein gültiges JSON/,
    );
  });

  it('refuses a file whose hooks were removed — the one edit that disarms it', async () => {
    await writeRoleSettings(dir, { hookEntry: HOOK });
    writeFileSync(roleSettingsPath(dir, 'coder'), JSON.stringify({ hooks: {} }));
    await expect(verifyRoleSettings(dir, { hookEntry: HOOK })).rejects.toThrow(RoleSettingsError);
  });

  it('refuses a stale file pointing at a hook path that no longer exists', async () => {
    // The upgrade failure: a container that kept `/app/claude` across a rebuild
    // would send every session's hook at a path that moved. The CLI reports
    // that as an errored hook — and an errored PreToolUse hook lets the tool run.
    await writeRoleSettings(dir, { hookEntry: '/app/old/hook-entry.js' });
    await expect(verifyRoleSettings(dir, { hookEntry: HOOK })).rejects.toThrow(/weicht.*ab/);
  });

  it('names every broken file at once, not just the first', async () => {
    await writeRoleSettings(dir, { hookEntry: HOOK });
    rmSync(roleSettingsPath(dir, 'coder'));
    rmSync(roleSettingsPath(dir, 'reviewer'));
    await expect(verifyRoleSettings(dir, { hookEntry: HOOK })).rejects.toThrow(
      /settings\.coder\.json[\s\S]*settings\.reviewer\.json/,
    );
  });
});
