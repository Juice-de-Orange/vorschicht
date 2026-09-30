#!/usr/bin/env node
/**
 * Result-contract gate (§6.3).
 *
 * §6.3 asks for "one schema per role, checked into `/app/contracts/`". The
 * schemas are generated from the zod definitions in `@vorschicht/shared` — that
 * is the only way the shape the CLI enforces and the shape the runner
 * re-validates can be guaranteed to agree, and §6.3 wants to know *which* layer
 * objected, which is only informative while both describe one contract.
 *
 * So the files are an artefact, and this gate is what keeps an artefact honest:
 * it regenerates them and fails when what is checked in has drifted. Same
 * bargain as the Drizzle mirror and the §9 transition map — written twice, with
 * the build failing on divergence.
 *
 *   node infra/scripts/gate-contracts.mjs           # check
 *   node infra/scripts/gate-contracts.mjs --write   # regenerate
 *
 * A second, cheaper check runs here too: the generated schema must not declare
 * a JSON Schema dialect the pinned CLI cannot load. Draft 2020-12 — zod's
 * default — is rejected outright by 2.1.220 with "no schema with key or ref";
 * the failure arrives at spawn time, for every role, which is a bad moment to
 * discover it (ADR 0002).
 *
 * Exit codes: 0 = in sync · 1 = finding · 2 = infra failure (A25).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, exit } from 'node:process';

const OUT_DIR = 'contracts';
const SHARED_DIST = './packages/shared/dist/index.js';

/** Dialects the pinned CLI's validator can resolve (ADR 0002). */
const SUPPORTED_DIALECTS = ['http://json-schema.org/draft-07/schema#'];

if (!existsSync(SHARED_DIST)) {
  console.error(
    `gate:contracts — ${SHARED_DIST} fehlt. Erst \`pnpm gate:typecheck\` (Infra-Fehler).`,
  );
  exit(2);
}

const { ROLE_NAMES, roleJsonSchema } = await import(`../../${SHARED_DIST.slice(2)}`);

const write = argv.includes('--write');
mkdirSync(OUT_DIR, { recursive: true });

/** Stable, diff-friendly rendering. The file is meant to be read in review. */
const render = (role) => `${JSON.stringify(roleJsonSchema(role), null, 2)}\n`;

const expected = new Map(ROLE_NAMES.map((role) => [`${role}.result.schema.json`, render(role)]));

/** @type {string[]} */
const findings = [];

for (const role of ROLE_NAMES) {
  const schema = roleJsonSchema(role);
  const dialect = schema.$schema;
  if (dialect && !SUPPORTED_DIALECTS.includes(dialect)) {
    findings.push(
      `${role}: Dialekt "${dialect}" — die gepinnte CLI kann ihn nicht auflösen und ` +
        'lehnt jeden Lauf dieser Rolle beim Start ab (ADR 0002).',
    );
  }
}

for (const [name, content] of expected) {
  const path = join(OUT_DIR, name);
  if (write) {
    writeFileSync(path, content);
    continue;
  }
  if (!existsSync(path)) {
    findings.push(`${name} fehlt — mit --write erzeugen.`);
    continue;
  }
  if (readFileSync(path, 'utf8') !== content) {
    findings.push(`${name} weicht vom zod-Vertrag ab — mit --write erneuern.`);
  }
}

// A contract for a role that no longer exists is worse than a missing one: it
// reads as current and describes nothing.
for (const name of readdirSync(OUT_DIR).filter((f) => f.endsWith('.schema.json'))) {
  if (expected.has(name)) continue;
  findings.push(`${name} gehört zu keiner Rolle mehr — löschen.`);
}

if (write) {
  console.log(`  ✓ ${expected.size} Vertragsdatei(en) in ${OUT_DIR}/ erneuert`);
  exit(findings.length > 0 ? 1 : 0);
}

if (findings.length > 0) {
  console.error('\ngate:contracts — Ergebnisverträge sind nicht aktuell:\n');
  for (const finding of findings) console.error(`  ✗ ${finding}`);
  console.error('\n  Erneuern: node infra/scripts/gate-contracts.mjs --write\n');
  exit(1);
}

console.log(`  ✓ ${expected.size} Ergebnisverträge stimmen mit den zod-Schemata überein`);
exit(0);
