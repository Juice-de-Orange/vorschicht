# Onboarding-Vorschlag: Example App (`example-app`)

> Synthetisches Beispiel. Dieser Vorschlag wurde mit `pnpm onboard -- --path <repo> --slug example-app --read-only`
> gegen das Sandbox-Projekt der Testsuite (`packages/core/src/sandbox.ts`) erzeugt und zeigt die Form,
> in der §20 einen Trockenlauf an den Betreiber übergibt. Kennungen und Zahlen sind erfunden; der
> Aufbau ist der echte (`packages/core/src/onboarding/report.ts`).

**Von:** Produktleitung (Petra) · **Projekt:** `example-app` · **Dringlichkeit:** P2 · **Datum:** 2026-09-30
**Lauf:** `0f3c1a2e-7b4d-4c6e-9a1f-2d5e8b7c6a90` · **Pfad:** `/projects/example-app`

## Kontext

Das Repository unter `/projects/example-app` ist analysiert worden: 148 versionierte Dateien,
62 Commits, zuletzt 3f9e2c1 2026-09-28 feat(api): pagination for /items.
Der Vorschlag legt fest, welche Prüfungen künftig vor jedem Merge in diesem Projekt laufen, wie fein
Arbeit darin aufgeteilt wird und ob es ausgerollt wird.
Er ist maschinell geprüft und in dieser Form übernehmbar.
Bis du entscheidest, ist nichts angelegt und nichts angefasst worden: die Analyse ist ein Trockenlauf
ohne jeden Schreibzugriff auf das Projekt (§20).

## Vorgeschlagene Konfiguration

**Stack:** Node 22 / TypeScript strict / Hono / Vitest / Biome, verwaltet mit pnpm; ein Paket,
Betrieb über Docker Compose (ein `app`-Dienst, Postgres), CI über GitHub Actions.

**Integrationszweig:** `main` — git symbolic-ref --short refs/remotes/origin/HEAD

**Anspruchs-Granularität (§10):** `directory` — Das Repo trennt `src/api`, `src/domain` und `src/db`
sauber und lässt die Grenze von Biome-Regeln erzwingen; ein Verzeichnis-Claim bildet genau eine
Modulgrenze ab. `package` wäre bei einem einzigen Paket dasselbe wie „alles" und würde jede zweite
Aufgabe serialisieren; `file` ließe zwei Sitzungen in dasselbe Modul.

**Deployment (§12):** `compose` — `docker-compose.yml` deklariert den Dienst `app` mit
`healthcheck: curl -f http://127.0.0.1:3000/healthz`; die Gesundheits-URL steht also im Repo, und
`infra/deploy.sh` fährt genau die Reihenfolge `compose build` → `run --rm app pnpm db:migrate` →
`up -d app`, die §12 als `compose` beschreibt.

### Gates (§11)

| Gate | Zustand | Befehl | Begründung |
|---|---|---|---|
| Peer-Review (§8.1) | gesperrt (läuft immer) | `—` | Gesperrtes Gate, das Vorschicht selbst ausführt. |
| Typprüfung | gesperrt (läuft immer) | `pnpm typecheck` | `package.json` deklariert `typecheck` als `tsc --noEmit`; der CI-Job `check` führt genau diesen Schritt aus. |
| Lint & Format | gesperrt (läuft immer) | `pnpm lint` | `package.json` deklariert `lint` als `biome check .`; dieselbe Zeile steht in `.github/workflows/ci.yml`. |
| Tests | gesperrt (läuft immer) | `pnpm test` | `package.json` deklariert `test` als `vitest run`; 41 Testdateien unter `src/`. |
| Secrets-Scan (gitleaks) | gesperrt (läuft immer) | `—` | Gesperrtes Gate, das Vorschicht selbst ausführt; das Repo führt keine eigene `.gitleaks.toml`. |
| Build | gesperrt (läuft immer) | `pnpm build` | `package.json` deklariert `build` als `tsc -p tsconfig.build.json`; das Dockerfile ruft denselben Schritt auf. |
| CHANGELOG geführt | an | `—` | `CHANGELOG.md` existiert und wird laut `CONTRIBUTING.md` je Änderung gepflegt. |
| Dokumentation mitgeführt | an | `—` | `docs/` mit `ARCHITECTURE.md`; `CONTRIBUTING.md` verlangt Doku-Änderungen im selben PR. |
| Migrationsprüfung (Milo) | an | `—` | `src/db/migrations/` enthält 12 SQL-Migrationen mit einem eigenen Runner; jede Änderung am Schema ist hier ein Risiko. |
| E2E | aus | `—` | Kein deklarierter Befehl — es gibt keine Browser- oder API-Strecke im Repo. Bewusst nicht erfunden. |
| DSGVO-/Rechtsprüfung (Lena) | aus | `—` | Keine Anhaltspunkte für personenbezogene Daten (siehe unten). |

### Woher die Befehle stammen

Jeder vorgeschlagene Befehl ist gegen das Projekt selbst geprüft worden, nicht nur übernommen — ein
Gate mit einem Befehl, den es nicht gibt, blockiert nie und wird nie rot, sondern meldet auf Dauer
einen Infrastrukturfehler (A25/A55.3).

- `pnpm typecheck` (Typprüfung) — belegt: `package.json` deklariert das Skript `typecheck`.
- `pnpm lint` (Lint & Format) — belegt: `package.json` deklariert das Skript `lint`.
- `pnpm test` (Tests) — belegt: `package.json` deklariert das Skript `test`.
- `pnpm build` (Build) — belegt: `package.json` deklariert das Skript `build`.

### Personenbezogene Daten

Der Vorschlag sieht keine Anhaltspunkte für personenbezogene Daten: keine Tabelle und kein Modul mit
Namen, Adressen, Zahlungs- oder Gesundheitsdaten; die einzige Nutzertabelle trägt eine ID und ein
Passwort-Hash. Ob daraus ein Rechts-Gate folgt, ist deine Entscheidung und Lenas Fach.

### Risiken laut Vorschlag

- `pnpm test` braucht eine laufende Postgres (`TEST_DATABASE_URL`): README Zeile 34 sagt das
  ausdrücklich; ohne Datenbank fällt das Pflicht-Gate `test` als Infrastruktur aus, nicht als Befund
  (A25) — die Studio-Umgebung muss sie bereitstellen.
- Kein Befehl für licenses, deps-audit und sast — bewusst weggelassen statt erfunden; das Projekt
  deklariert dafür nichts.
- Der Compose-Deploy ist die Beschreibung dessen, was `infra/deploy.sh` tut, keine Freigabe: nichts
  wird ausgerollt, bevor du es entscheidest, und der erste Rollout ist der Moment, in dem sich zeigt,
  ob die Gesundheits-URL stimmt.

**Zuständige Abteilungen (§8):** Entwicklung, QA, Betrieb

## Einschätzung der Produktleitung

Example App ist ein kleines, sauber geschnittenes Node-Projekt mit einem Paket, deklarierten
Befehlen für alle vier befehlspflichtigen Pflicht-Gates und einer CI, die genau diese Befehle
ausführt. Die Migrationsprüfung schlage ich an vor, weil das Schema mit einem eigenen Runner
verwaltet wird und ein Fehler dort den Rollback-Pfad (§12) betrifft. E2E lasse ich aus, weil es
keine Strecke gibt — ein erfundener Befehl wäre ein Gate, das nie rot wird.

Nicht geprüft habe ich, ob die Befehle in der Studio-Umgebung tatsächlich durchlaufen — ich habe
keine Shell, und das Projekt ist ein Trockenlauf (A41).

## Optionen

### 1. So übernehmen — Projekt anlegen, weiterhin nur analysieren *(Empfehlung)*

- **Dafür:** Das Projekt ist danach im Studio sichtbar und seine Gate-Konfiguration steht fest, ohne
  dass irgendetwas darin geschrieben werden darf (A41).
- **Dafür:** Jede spätere Änderung an dieser Konfiguration ist ein eigener, protokollierter Schritt.
- **Dagegen:** Es passiert zunächst nichts — das Projekt liegt da und wird nicht bearbeitet.

### 2. Übernehmen und Schreibrechte freigeben

- **Dafür:** Das Studio kann in diesem Projekt planen, bauen, prüfen und zusammenführen — unter den
  Gates aus der Tabelle oben.
- **Dagegen:** Der erste echte Merge in einem fremden Projekt ist der Moment, in dem sich zeigt, ob
  die Befehle stimmen.

### 3. Ablehnen

- **Dafür:** Nichts wird angelegt; der Vorschlag bleibt als Datei erhalten.
- **Dagegen:** Das Projekt bleibt außerhalb des Studios.

### Freitext

Eigene Antwort möglich; sie wird wörtlich in die Entscheidung übernommen (§15).
