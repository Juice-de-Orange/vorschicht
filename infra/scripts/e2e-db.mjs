#!/usr/bin/env node
/**
 * Die Browserstrecke bekommt eine **eigene** Datenbank, auch auf einem
 * bereitgestellten Server.
 *
 * `TEST_DATABASE_URL` trägt zwei verschiedene Verträge, und im eigenen Container
 * fallen sie zusammen:
 *
 *   * die Integrationstests lesen sie als **Admin**-URL und legen sich je Suite
 *     eine eigene Datenbank an (`createTestDatabase`);
 *   * `e2e/global-setup.ts` liest sie als **die** Wegwerf-Datenbank — sein
 *     Kommentar sagt „throwaway" — und migriert sie einfach.
 *
 * Solange `with-test-db.sh` sich selbst einen frischen Container startet, ist
 * beides dasselbe. Seit A127 kann eine Datenbank auch *bereitgestellt* werden,
 * und dann ist sie geteilt und schon benutzt — womit der zweite Vertrag bricht.
 *
 * **Gemessen, nicht vermutet:** genau das hat am 16.8.2026 einen Browserfall rot
 * gemacht. `buero.spec.ts` sät genau einen Coder-Lauf und erwartet an dessen
 * Platz „Clara"; es stand „Chris" dort, weil `seatName` den Index nach Sitzalter
 * vergibt (A46.5) und die Integrationstests im selben Lauf ältere Coder-Läufe
 * hinterlassen hatten. Ein roter Browserfall, der nichts über den Browser sagte.
 *
 * Also legt dieser Wrapper eine frische Datenbank an, reicht sie als
 * `TEST_DATABASE_URL` weiter und räumt sie wieder weg — womit die Strecke
 * dieselbe Zusicherung bekommt wie in einem eigenen Container.
 */
import { spawn } from 'node:child_process';
import { argv, env, exit } from 'node:process';
import { createTestDatabase } from '@vorschicht/db';

const command = argv.slice(2);
if (command.length === 0) {
  console.error('e2e-db: kein Kommando angegeben.');
  exit(2);
}

const db = await createTestDatabase('e2e');
try {
  const code = await new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: 'inherit',
      // Beide Namen, weil `playwright.config.ts` `DATABASE_URL` an die Server
      // weiterreicht und `global-setup.ts` `TEST_DATABASE_URL` liest.
      env: { ...env, TEST_DATABASE_URL: db.url, DATABASE_URL: db.url },
    });
    child.on('close', (status) => resolve(status ?? 1));
    // Ein nicht startbarer Prozess hat nichts geprüft — 2, nicht 1 (A25, A125).
    child.on('error', () => resolve(2));
  });
  exit(code);
} finally {
  // Best effort: eine liegengebliebene Testdatenbank kostet Platz, ein hier
  // geworfener Fehler kostet das Ergebnis des Laufs.
  await db.drop().catch(() => {});
}
