#!/usr/bin/env node
/**
 * Append-only migration lint.
 *
 * §5 makes append-only the design rule wherever state history matters, and §18
 * makes the event log the source of truth. Conventions erode; this gate does
 * not. It fails the build when a migration would hand the app role a way to
 * rewrite history — by granting UPDATE/DELETE on a protected table, by dropping
 * its guard trigger, or by adding a protected table without a guard at all.
 *
 * The protected set lives in packages/db/append-only.json so that adding a
 * table to it is a deliberate, reviewable act.
 *
 * Exit codes: 0 = clean · 1 = finding · 2 = infra failure.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exit } from 'node:process';

const MANIFEST = 'packages/db/append-only.json';
const MIGRATIONS_DIR = 'packages/db/migrations';

if (!existsSync(MANIFEST)) {
  console.error(`gate:migrations — ${MANIFEST} fehlt.`);
  exit(2);
}

/** @type {{ tables: string[], guardSuffix: string }} */
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const protectedTables = new Set(manifest.tables);

if (!existsSync(MIGRATIONS_DIR)) {
  console.log('  ✓ noch keine Migrationen vorhanden');
  exit(0);
}

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

/** @type {string[]} */
const findings = [];

/** Strip SQL comments so a commented-out example never trips the lint. */
function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

const guarded = new Set();

for (const file of files) {
  const raw = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
  const sql = stripComments(raw);

  for (const table of protectedTables) {
    const grant = new RegExp(
      `grant[^;]*\\b(update|delete|truncate)\\b[^;]*\\bon\\b[^;]*\\b${table}\\b`,
      'gis',
    );
    if (grant.test(sql)) {
      findings.push(`${file}: GRANT UPDATE/DELETE/TRUNCATE auf append-only-Tabelle "${table}"`);
    }

    const dropGuard = new RegExp(
      `drop\\s+trigger[^;]*\\b${table}${manifest.guardSuffix}\\b`,
      'gis',
    );
    if (dropGuard.test(sql)) {
      findings.push(`${file}: Guard-Trigger für "${table}" wird gelöscht`);
    }

    // Both spellings count: migrations must be re-runnable, so guards are
    // written as CREATE OR REPLACE TRIGGER.
    const createGuard = new RegExp(
      `create\\s+(?:or\\s+replace\\s+)?trigger\\s+${table}${manifest.guardSuffix}\\b`,
      'is',
    );
    if (createGuard.test(sql)) guarded.add(table);
  }

  if (/\bdisable\s+trigger\b/is.test(sql)) {
    findings.push(`${file}: "ALTER TABLE … DISABLE TRIGGER" hebelt den Append-only-Schutz aus`);
  }
}

for (const table of protectedTables) {
  if (!guarded.has(table)) {
    findings.push(
      `Tabelle "${table}" ist als append-only deklariert, aber keine Migration legt den ` +
        `Guard-Trigger "${table}${manifest.guardSuffix}" an`,
    );
  }
}

if (findings.length === 0) {
  console.log(
    `  ✓ ${files.length} Migration(en), ${protectedTables.size} append-only-Tabelle(n) geschützt`,
  );
  exit(0);
}

console.error('\ngate:migrations — Append-only-Disziplin verletzt:\n');
for (const f of findings) console.error(`  ✗ ${f}`);
console.error('');
exit(1);
