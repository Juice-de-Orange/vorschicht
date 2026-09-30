#!/usr/bin/env node
/**
 * CLI contract gate (A32).
 *
 * `--max-turns` is the primary run cap and it is **undocumented**: removed from
 * `--help` on 2.1.220, still parsing, still producing `error_max_turns`. An
 * undocumented flag can disappear in any release without a changelog entry, and
 * the failure mode is silent — runs would simply stop being capped.
 *
 * So the flag's continued existence is a build-breaking assertion. Every check
 * here is free: the trick is to pass the flag under test together with a
 * deliberately unknown one and see which the parser complains about first. If
 * it names the unknown flag, the flag under test was accepted.
 *
 * Proving that a cap actually *fires* needs a real session and belongs in
 * `demo-phase1.sh`, not in a gate that runs on every commit.
 *
 * Exit codes: 0 = contract holds · 1 = finding · 2 = infra failure (A25).
 */
import { spawnSync } from 'node:child_process';
import { exit } from 'node:process';

const CLI = process.env.VORSCHICHT_CLAUDE_BIN ?? 'claude';
const CANARY = '--zzz-vorschicht-unbekannt';

if (spawnSync(CLI, ['--version'], { encoding: 'utf8' }).status !== 0) {
  console.error(`gate:cli-contract — ${CLI} nicht ausführbar (Infra-Fehler, kein Finding).`);
  exit(2);
}

const HELP = (() => {
  const result = spawnSync(CLI, ['--help'], { encoding: 'utf8', timeout: 30_000 });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
})();

/**
 * Is `flag` accepted by the argument parser?
 *
 * Documented flags are read straight out of `--help`. For flags that are *not*
 * listed — `--max-turns` is currently the only one, and the reason this gate
 * exists — the parser is probed instead: pass a value of the wrong type and see
 * whether the error names the flag. A flag the parser does not know produces
 * "unknown option", not a type complaint.
 *
 * Probing with `--help` alone does not work: commander prints the help text and
 * exits before it ever reports an unknown option, so every flag would look
 * accepted or rejected for the wrong reason.
 */
function accepts(flag) {
  if (new RegExp(`(^|[\\s,])${flag}([\\s,=]|$)`, 'm').test(HELP)) {
    return { ok: true, how: 'dokumentiert' };
  }

  const probe = spawnSync(CLI, [flag, 'nicht-verwertbar', CANARY], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;

  if (/unknown option/i.test(output) && output.includes(flag))
    return { ok: false, how: 'unbekannt' };
  // The parser complained about the *value* or about the canary — either way
  // it recognised the flag itself.
  if (output.includes(CANARY) || /invalid|must be/i.test(output)) {
    return { ok: true, how: 'undokumentiert, aber akzeptiert' };
  }
  return { ok: false, how: 'unklar' };
}

const REQUIRED = [
  ['--max-turns', '1', 'A32 Kappe 1 — undokumentiert, deshalb dieser Test'],
  ['--max-budget-usd', '1', 'A32 Kappe 2'],
  ['--input-format', 'stream-json', 'ADR 0001 — get_usage braucht offenes stdin'],
  ['--output-format', 'stream-json', '§6.2 Transport'],
  ['--session-id', '00000000-0000-4000-8000-000000000000', 'Crash-Sicherheit: eigene Run-ID'],
  ['--include-hook-events', undefined, '§6.6 Containment-Nachweis zur Laufzeit'],
  ['--json-schema', '{}', '§6.3 Ergebnisvertrag'],
  ['--append-system-prompt', 'x', '§6.2 Rollenprofil'],
  ['--allowedTools', 'Read', '§6.2 Werkzeug-Whitelist'],
  ['--setting-sources', 'project', '§6.6 keine Host-Settings in Agentensitzungen'],
];

/** @type {string[]} */
const findings = [];

console.log(`  CLI: ${spawnSync(CLI, ['--version'], { encoding: 'utf8' }).stdout?.trim()}`);
for (const [flag, , why] of REQUIRED) {
  const { ok, how } = accepts(flag);
  console.log(`  ${ok ? '✓' : '✗'} ${flag.padEnd(24)} ${how.padEnd(28)} ${why}`);
  if (!ok) findings.push(`${flag} wird nicht mehr akzeptiert — ${why}`);
}

if (findings.length > 0) {
  console.error('\ngate:cli-contract — der Runner steht auf Flags, die es nicht mehr gibt:\n');
  for (const finding of findings) console.error(`  ✗ ${finding}`);
  console.error(
    '\n  Das ist Absicht: A32 macht den Wegfall einer Kappe zum Build-Fehler,\n' +
      '  damit Läufe nicht still ungekappt weiterlaufen. CLI-Pin prüfen (A27).\n',
  );
  exit(1);
}

console.log('  ✓ alle vom Runner benötigten Flags werden akzeptiert');
exit(0);
