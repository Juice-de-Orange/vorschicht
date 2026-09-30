# Prüfbericht ceed365f — Tote Verdrahtung

**Datum:** 2026-08-25 · **Anlass:** phase_close · **Domäne:** `dead_wiring`

## 1. Prüfumfang und Stichprobe

Der gesamte bisherige Bau.

Gezogen (8): `packages/shared/src/einstellungen.ts:MailEinstellungView`, `packages/core/src/personas/settings.ts:PERSONA_AUDIT_ACTION`, `packages/core/src/sandbox.ts:setSandboxRelease`, `packages/shared/src/deploy.ts:validateDeployConfig`, `packages/shared/src/inbox.ts:RunView`, `packages/shared/src/usage.ts:RateLimitWindow`, `packages/core/src/report/generator.ts:plural`, `packages/shared/src/escalation.ts:isPolicyMemorySource`
Geprüft laut Bericht (8): `packages/shared/src/einstellungen.ts:MailEinstellungView`, `packages/core/src/personas/settings.ts:PERSONA_AUDIT_ACTION`, `packages/core/src/sandbox.ts:setSandboxRelease`, `packages/shared/src/deploy.ts:validateDeployConfig`, `packages/shared/src/inbox.ts:RunView`, `packages/shared/src/usage.ts:RateLimitWindow`, `packages/core/src/report/generator.ts:plural`, `packages/shared/src/escalation.ts:isPolicyMemorySource`

### Zusammenfassung des Prüfers

Prüfbericht Betriebsprüfung ceed365f — Domäne „Tote Verdrahtung"

**Der schwere Fund ist eine geschlossene Kette.** Das Onboarding kann eine `compose`-Deploy-Konfiguration nur in einer Form schreiben, die das eigene Schema zurückweist. `resolveDeploy` (onboarding/verify.ts:483-486) behält vom Vorschlag nur `method` und `rationale` und wirft `service`, `composeFile`, `healthUrl` weg — obwohl der Vorschlagsvertrag sie führt (shared/agent-result.ts:285-294) und `deployConfigSchema` alle drei für `compose` verlangt. Geprüft wird das nirgends: `OnboardingService.apply` prüft nur die Gate-Konfiguration (service.ts:165), `ProjectService.create` schreibt `deploy_config` ungeprüft (project-service.ts:97), und `validateDeployConfig` — die Funktion, die genau das sagen würde — hat im Produktivcode keinen einzigen Aufrufer, nur Tests. Folge im Betrieb: `assertDeployable` lässt die Methode durch (merge-queue.ts:732-734), die Aufgabe geht auf `deploying`, `readDeployConfig` liest das Dokument als `none`, die Maschine antwortet `unsupported` (deploy/service.ts:157-162), und der Takt stellt die Aufgabe als Verteilerdefekt in Quarantäne. Jeder Merge eines so onboardeten Projekts endet dort. Einen zweiten Schreibweg gibt es nicht: jede vollständige compose-Konfiguration dieses Repositories steht ausschließlich in Integrationstests, per rohem SQL gesetzt — deshalb ist die Lücke nie aufgefallen. CHANGELOG.md:533-540 meldet „`compose` ist jetzt drin"; belegt ist damit nur, dass die Methode durchgereicht wird.

**Das Prüfwerkzeug selbst behauptet zu viel.** Die zweite Liste des Sammlers (audit/domains.ts:543-546) sagt ohne Vorbehalt „an nichts angeschlossen". Zwei meiner acht Stichprobenposten widerlegen das durch Lesen: `plural` hat zwölf Produktivstellen (generator.ts:533-765), `PERSONA_AUDIT_ACTION` eine (settings.ts:121) — beide in Template-Literalen, die der Filter wegwirft. Das ist im `limits`-Absatz für die *erste* Liste eingeräumt, nicht für die zweite.

Drei Posten (`MailEinstellungView`, `RunView`, `RateLimitWindow`) sind `z.infer`-Typaliasse über benutzten Schemata, `setSandboxRelease` gehört zu einem Fixture-Modul: kein Befund. `isPolicyMemorySource` ist nachweislich unbenutzt, aber harmlos — die Regel greift per SQL.

## 2. Bestätigte Funde

**1. Defekt** — Das Onboarding schreibt für `compose` ein Deploy-Dokument, das `deployConfigSchema` zurückweist, und der dafür vorhandene Validator `validateDeployConfig` hat im Produktivcode keinen Aufrufer.
   Beleg: packages/core/src/onboarding/verify.ts:483-486 gibt `{ method: proposal.method, rationale: proposal.rationale }` zurück und verwirft `service`, `composeFile`, `healthUrl`, `migrateCommand`, die der Vorschlagsvertrag in packages/shared/src/agent-result.ts:285-294 führt. `IMPLEMENTED_DEPLOY_METHODS` enthält seit A115.4 `compose` (verify.ts:94), der Zweig ist also erreichbar. packages/shared/src/deploy.ts:126-134 verlangt für `compose` `composeFiles` (min 1), `service` (min 1) und `healthUrl` (z.url()) — alle drei ohne Default. Auf dem Schreibweg prüft nichts: onboarding/service.ts:165 prüft nur `verification.config` (Gates), service.ts:187 reicht `deployConfig` unverändert weiter, project-service.ts:97 schreibt die Spalte per `sql.json` ohne Prüfung; ein `setDeployConfig` gibt es in `ProjectService` nicht (Gegenstück `setGateConfig` validiert, project-service.ts:158-167). Grep über /work nach `validateDeployConfig`: Treffer nur in shared/src/deploy.ts:167 (Definition), deploy.test.ts:73, deploy/compose.itest.ts:294, deploy/service.itest.ts:61 — kein Produktivaufrufer. Grep nach `deploy_config =`: nur Testhelfer (merge-queue.itest.ts:202-204, build-scheduler.itest.ts:181-183) und e2e-Fixtures.
   Vorgeschlagene mechanische Absicherung: Ein Aufruf von `validateDeployConfig` in `OnboardingService.apply` (neben der bestehenden Gate-Prüfung) oder in `ProjectService.create` würde das mechanisch verhindern; zusätzlich müsste `resolveDeploy` die Felder des Vorschlags durchreichen — dabei fällt auf, dass der Vorschlag `composeFile` (Einzahl, String) und das Schema `composeFiles` (Mehrzahl, Array) heißt, die beiden Enden sind also nie zusammengeführt worden.
   Aufgabe: 5896a1f9-96b1-4ff9-83be-ea7ed4a4e117
   Folge: Aufgabe 5896a1f9-96b1-4ff9-83be-ea7ed4a4e117 mit Priorität P1 angelegt.

**2. Fehlender Nachweis** — Kein Test führt eine Onboarding-Übernahme bis zu einem lesbaren `deploy_config` — jede vollständige compose-Konfiguration im Repository wird von Testhelfern per rohem SQL gesetzt.
   Beleg: Gesucht nach einem Test, der ein per `OnboardingService.apply` angelegtes Projekt ausrollt. Gefunden statt dessen: verify.test.ts:370-384 („speichert „compose", seit die Maschine dafür existiert") übergibt im Vorschlag `service: 'web'` und sichert danach nur `result.deployConfig.method === 'compose'` zu — dass `service` überlebt hat, prüft es nicht, und es überlebt nicht (verify.ts:485). Alle Strecken-Tests umgehen den Schreibweg: merge-queue.itest.ts:202-204 und build-scheduler.itest.ts:181-183 definieren je einen eigenen `setDeployConfig`-Helfer mit `UPDATE projects SET deploy_config = …`; merge-queue.itest.ts:1395-1403 setzt die vollständige Konfiguration von Hand, genau mit dem Kommentar, dass ein halb gefülltes Dokument den Zweig daneben prüfen würde. Ein Test, der prüft, dass die *gespeicherte* Konfiguration eines onboardeten Projekts `deployConfigSchema` besteht, existiert nicht.
   Vorgeschlagene mechanische Absicherung: Eine Zusicherung in der Onboarding-Test-Strecke, dass `deployConfigSchema.safeParse(project.deployConfig).success` für jede von `IMPLEMENTED_DEPLOY_METHODS` zugelassene Methode gilt.
   Aufgabe: 70dc582c-df08-44b9-befd-4ab74a6489d3
   Folge: Aufgabe 70dc582c-df08-44b9-befd-4ab74a6489d3 mit Priorität P2 angelegt.

**3. Defekt** — Der Kommentar über `readDeployConfig` behauptet, ein unlesbares Deploy-Dokument werde von der Projektseite und der Merge-Queue sichtbar gemacht; die Projektseite liest die Spalte überhaupt nicht.
   Beleg: packages/shared/src/deploy.ts:190-191: „The project page and the merge queue both surface the refusal separately, so it is loud rather than silent." `ProjectSettingsView` (apps/server/src/projects.ts:42-66) führt `gateConfig`, `resolvedGateIds`, `releases`, `releaseSource` — kein Feld für `deployConfig` und keines für dessen Fehler. Grep über apps/server/src/app.ts nach „deploy" (case-insensitiv): nur zwei Kommentarzeilen (301, 739), keine Route. apps/server/src/main.ts:215-217 registriert `list` und `saveProjectGates`, kein Gegenstück für Deploy. Die zweite Hälfte des Satzes greift nur teilweise: `assertDeployable` (merge-queue.ts:731-734) weist eine Methode *ohne registriertes Ziel* zurück, ein halb gefülltes `compose` in einem Studio mit registriertem compose-Ziel geht durch.
   Vorgeschlagene mechanische Absicherung: Mechanisch nicht erzwingbar; der Satz gehört korrigiert, sobald der Schreibweg validiert.
   Aufgabe: 5ca003e3-ac3f-4804-9bce-7cfceb74f0b4
   Folge: Aufgabe 5ca003e3-ac3f-4804-9bce-7cfceb74f0b4 mit Priorität P1 angelegt.

**4. Defekt** — Der Beweisbrief der Domäne behauptet für seine zweite Liste ohne Vorbehalt „an nichts angeschlossen", obwohl der Zähler Template-Literale verwirft — zwei von acht Stichprobenposten sind dadurch falsch klassifiziert.
   Beleg: packages/core/src/audit/domains.ts:543-546 formuliert: „Im Produktivcode steht jeder von ihnen genau einmal: an seiner Definition. Sie sind getestet und grün und an nichts angeschlossen." `stripCodeNoise` (domains.ts:197) entfernt jedes Template-Literal samt Interpolationen. Widerlegt durch Lesen: `plural` (generator.ts:382) wird im Produktivcode zwölfmal aufgerufen — generator.ts:533, 575, 576, 577, 578, 637, 638, 687, 688, 762, 763, 765 —, sämtlich in Template-Literalen; `PERSONA_AUDIT_ACTION` (personas/settings.ts:70) steht in personas/settings.ts:121 in einem SQL-Tagged-Template. Beide stehen in der zweiten Liste. Der Vorbehalt in domains.ts:559-563 räumt die Überentfernung ein, ordnet ihre Folge aber der ersten Liste zu („erscheint dann als Verdacht" — „Verdacht" ist das Wort, mit dem domains.ts:538 die erste Liste hedged); die zweite Liste trägt keinen Vorbehalt. Der Modulkopf (domains.ts:11-15) verlangt zugleich: „It gathers, it does not judge."
   Vorgeschlagene mechanische Absicherung: Denselben Vorbehalt an die zweite Listenüberschrift hängen und sie wie die erste als Verdacht formulieren; mechanisch günstiger wäre, für die zweite Liste zusätzlich über dem *ungestrippten* Produktivtext zu zählen und einen Treffer dort als Ausschluss zu werten.
   Aufgabe: 08823285-1f22-411f-896d-939cc02e55c4
   Folge: Aufgabe 08823285-1f22-411f-896d-939cc02e55c4 mit Priorität P1 angelegt.

**5. Defekt** — `isPolicyMemorySource` ist ein getesteter Prädikat-Export ohne jeden Produktivaufrufer — §15s Regel wird ausschließlich in SQL durchgesetzt.
   Beleg: packages/shared/src/escalation.ts:166-168 definiert die Funktion. Grep über /work nach `isPolicyMemorySource`: Treffer nur in escalation.ts:166 (Definition) und escalation.test.ts:9, 95, 103, 113, 126. Die Regel selbst greift im Produktivcode über die Konstante, nicht über das Prädikat: escalation-service.ts:445 und :474 filtern mit `source = ANY(${POLICY_MEMORY_SOURCES})`.
   Vorgeschlagene mechanische Absicherung: Entweder die SQL-Filter auf das Prädikat umstellen oder das Prädikat samt Tests entfernen.
   Aufgabe: a6342792-203f-4d35-923e-1a8153d6bd22
   Folge: Aufgabe a6342792-203f-4d35-923e-1a8153d6bd22 mit Priorität P1 angelegt.

## 3. Verdachtsmomente

Keine.

## 4. Nicht prüfbar

- Kein Shell, kein git, kein Datenbankzugriff: ich konnte nicht feststellen, ob heute ein Projekt mit `deploy_config.method = 'compose'` in der Datenbank steht. Die Betriebswirkung des ersten Befundes ist damit unbeziffert — der Codepfad ist belegt, die Anzahl betroffener Projekte nicht.
- Kein Test war ausführbar. Jede Aussage über Tests in diesem Bericht stammt aus dem Lesen des Testcodes, nicht aus einem Lauf.
- Statische Suche über Bezeichner: dynamische Aufrufe, Reflexion und Konfiguration aus der Datenbank sind darin nicht sichtbar (aus dem Beweisbrief übernommen).
- Ein namentlich weitergereichter Barrel-Export (`export { X } from …`) zählt als zweites Vorkommen und fällt aus beiden Kandidatenlisten heraus. Der Pool, aus dem meine Stichprobe gezogen wurde, kann tote Namen dieser Form deshalb systematisch auslassen; das konnte ich nicht gegenprüfen.
- Der Sammler zählt Fixture-Module, die in Produktivpaketen liegen (sandbox.ts, deploy/fake-machines.ts, vault/pdf-fixture.ts, backend/stubs.ts, scans/radar/feeds.ts), als Produktivcode. Ich habe sie anhand ihrer Kopfkommentare als Fixtures eingestuft — ein Urteil aus Prosa, kein mechanisches Merkmal.
- Drei Stichprobenposten (`MailEinstellungView`, `RunView`, `RateLimitWindow`) sind `z.infer`-Typaliasse über Schemata, die benutzt werden (einstellungen.ts:96, inbox.ts:560, usage.ts:40/78/79). Ob der Typalias selbst als öffentliche Fläche gewollt ist oder überflüssig, lässt sich ohne einen Konsumenten außerhalb dieses Baumes nicht entscheiden; ich habe sie nicht als tot gewertet.
- Ich habe nur die Domäne „tote Verdrahtung" geprüft. Angehakte Gates, Zahlen des Wochenberichts und die Containment-Hooks sind hier nicht angesehen worden — dass ich kein `gate_invalid` melde, ist keine Aussage über sie.

## 5. Revidierte Annahmen

Keine.

## 6. Urteil

funde_zu_beheben — echte Funde, keiner davon entwertet ein Gate.

