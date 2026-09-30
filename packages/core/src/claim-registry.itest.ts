/**
 * The claim registry against a real Postgres (§10).
 *
 * The Phase 2 exit gate asks for one thing in particular — "overlapping claims
 * are detected and serialized — never concurrently active" — and that is a
 * statement about two writers, so it cannot honestly be tested against a fake.
 *
 * The decisive case is *not* the obvious one. Firing two `acquire()` calls with
 * `Promise.all` and asserting that one loses passes just as happily with the
 * project lock removed, because the two transactions rarely interleave where it
 * would matter. That test is kept — one winner is still the property §10 asks
 * for — but the proof that acquisition is serialised is the test below it,
 * which holds the lock from outside and shows `acquire()` waiting.
 *
 * No model tokens are spent. A "coder" here is a state transition.
 */
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import { InvalidClaimGlobError } from '@vorschicht/shared';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CLAIM_LOCK_NAMESPACE, ClaimError, ClaimRegistry } from './claim-registry.js';
import { EventLog } from './event-log.js';
import { ProjectService } from './project-service.js';
import { reconcile } from './reconcile.js';
import { TaskService } from './task-service.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('Claim-Registry (§10)', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let tasks: TaskService;
  let projects: ProjectService;
  let eventLog: EventLog;
  let registry: ClaimRegistry;

  beforeAll(async () => {
    database = await createTestDatabase('claims');
    // Four: the race test below needs two acquisitions in flight at once, and
    // each of them holds a connection for the length of its transaction.
    sql = createSql({ url: database.url, max: 4 });
    eventLog = new EventLog(sql);
    tasks = new TaskService({ sql, eventLog });
    projects = new ProjectService(sql);
    registry = new ClaimRegistry({ sql, tasks, projects, eventLog });
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
  });

  let seq = 0;
  const touched: string[] = [];

  /**
   * §10's invariant, after **every** case — not only the three that thought to
   * ask.
   *
   * It used to be three explicit calls, and the exit gate's evidence line in
   * `CLAUDE.md` said "after every case". The first Betriebsprüfung of Phase 3
   * read the tick against the file and found the gap (`process`, 2026-08-02):
   * the fourteen other specs — the ones where a waiting task moves up, where a
   * park holds claims, where an abort releases them, where a re-plan changes
   * the set — are exactly the cases in which two tasks contend for the same
   * files, and none of them checked. The finding did not invalidate the gate,
   * because the gate's own sentence was proven elsewhere; it invalidated the
   * *evidence line*, which the next reader would have believed.
   *
   * Lifted here rather than the sentence being softened: making the claim true
   * is worth more than making it accurate, and it costs one query per case.
   */
  afterEach(async () => {
    for (const projectId of touched) {
      expect(await registry.audit(projectId)).toEqual([]);
    }
    touched.length = 0;
  });

  /** A fresh project, so no two tests contend for the same claim space. */
  async function newProject(): Promise<string> {
    seq += 1;
    const project = await projects.create({
      slug: `claims-p${seq}`,
      name: `Projekt ${seq}`,
      rootPath: `/tmp/claims-p${seq}`,
    });
    touched.push(project.id);
    return project.id;
  }

  /** A task that has finished planning and is ready to take its claims. */
  async function planned(projectId: string, title: string, globs: string[]): Promise<string> {
    const task = await tasks.create({ projectId, title });
    await tasks.transition(task.id, 'planning');
    await registry.register(task.id, globs);
    return task.id;
  }

  it('nimmt die Claim-Liste des Planners entgegen und merkt sie vor', async () => {
    const projectId = await newProject();
    const taskId = await planned(projectId, 'Erste Aufgabe', ['src/**', './docs/']);

    const claims = await registry.claimsOf(taskId);
    expect(claims.map((c) => c.glob)).toEqual(['docs/**', 'src/**']);
    // Vorgemerkt, nicht belegt: der Planner hat geschrieben, geplant hat noch
    // niemand. Sonst blockierte eine Absichtserklärung das ganze Projekt.
    expect(claims.every((c) => c.status === 'pending')).toBe(true);
    expect(await registry.heldGlobs(taskId)).toEqual([]);
  });

  it('weist Muster zurück, über die sich keine Kollision berechnen lässt', async () => {
    const projectId = await newProject();
    const task = await tasks.create({ projectId, title: 'Kaputte Claims' });
    await tasks.transition(task.id, 'planning');
    await expect(registry.register(task.id, ['src/[ab].ts'])).rejects.toBeInstanceOf(
      InvalidClaimGlobError,
    );
    await expect(registry.register(task.id, ['../fremdes-projekt/**'])).rejects.toBeInstanceOf(
      InvalidClaimGlobError,
    );
    expect(await registry.claimsOf(task.id)).toEqual([]);
  });

  it('belegt die Dateien beim Übergang nach "Dateien reserviert"', async () => {
    const projectId = await newProject();
    const taskId = await planned(projectId, 'Belegen', ['packages/core/**']);

    const result = await registry.acquire(taskId);
    expect(result.acquired).toBe(true);
    expect(result.task.state).toBe('claimed');
    expect((await registry.claimsOf(taskId)).every((c) => c.status === 'active')).toBe(true);
    expect(await registry.heldGlobs(taskId)).toEqual(['packages/core/**']);

    const [event] = await sql`
      SELECT payload FROM event_log WHERE task_id = ${taskId} AND kind = 'claims.acquired'
    `;
    expect(event?.payload).toEqual({ globs: ['packages/core/**'] });
  });

  it('lässt zwei disjunkte Aufgaben nebeneinander laufen', async () => {
    const projectId = await newProject();
    const a = await planned(projectId, 'Web', ['apps/web/**']);
    const b = await planned(projectId, 'Server', ['apps/server/**', 'docs/*.md']);

    expect((await registry.acquire(a)).acquired).toBe(true);
    expect((await registry.acquire(b)).acquired).toBe(true);
    expect(await registry.audit(projectId)).toEqual([]);
  });

  it('serialisiert überlappende Claims und benennt den Blocker', async () => {
    const projectId = await newProject();
    const first = await planned(projectId, 'Refactoring Kern', ['packages/core/**']);
    const second = await planned(projectId, 'Typprüfung', ['**/*.ts']);

    expect((await registry.acquire(first)).acquired).toBe(true);

    const blocked = await registry.acquire(second);
    expect(blocked.acquired).toBe(false);
    expect(blocked.task.state).toBe('planning');
    expect(blocked.conflicts).toHaveLength(1);
    expect(blocked.conflicts[0]?.taskId).toBe(first);
    expect(blocked.conflicts[0]?.overlaps).toEqual([
      { ours: '**/*.ts', theirs: 'packages/core/**' },
    ]);
    expect(blocked.conflicts[0]?.reason).toContain('Refactoring Kern');

    // Und dieselbe Auskunft ohne Schreibversuch — das ist, was das Dashboard fragt.
    const blockers = await registry.blockers(second);
    expect(blockers.map((b) => b.taskId)).toEqual([first]);

    // §10: niemals gleichzeitig aktiv.
    expect(await registry.audit(projectId)).toEqual([]);
  });

  it('gibt die Dateien erst beim Abschluss frei — und dann rückt der Wartende nach', async () => {
    const projectId = await newProject();
    const first = await planned(projectId, 'Erste', ['src/**']);
    const second = await planned(projectId, 'Zweite', ['src/index.ts']);
    await registry.acquire(first);
    expect((await registry.acquire(second)).acquired).toBe(false);

    // Der ganze Weg bis zum Merge — die Claims bleiben die ganze Zeit belegt.
    for (const state of ['coding', 'review', 'gates', 'merge_queue', 'merging'] as const) {
      await tasks.transition(first, state);
      expect(await registry.heldGlobs(first)).toEqual(['src/**']);
      expect((await registry.acquire(second)).acquired).toBe(false);
    }

    const released = await registry.release(first, 'nach dem Merge');
    expect(released).toEqual(['src/**']);
    expect((await registry.claimsOf(first)).every((c) => c.status === 'released')).toBe(true);

    const now = await registry.acquire(second);
    expect(now.acquired).toBe(true);
  });

  it('hält die Claims über eine Pause hinweg (§10, §15)', async () => {
    const projectId = await newProject();
    const first = await planned(projectId, 'Wartet auf Entscheidung', ['infra/**']);
    const second = await planned(projectId, 'Will dasselbe', ['infra/nginx/**']);
    await registry.acquire(first);
    await tasks.transition(first, 'coding');
    await tasks.transition(first, 'needs_decision', { resumeState: 'coding' });

    const claims = await registry.claimsOf(first);
    expect(claims.every((c) => c.status === 'parked')).toBe(true);

    const blocked = await registry.acquire(second);
    expect(blocked.acquired).toBe(false);
    expect(blocked.conflicts[0]?.reason).toContain('Entscheidung');

    // Und nach der Antwort läuft die erste Aufgabe genau dort weiter.
    await tasks.resume(first);
    expect((await registry.claimsOf(first)).every((c) => c.status === 'active')).toBe(true);
  });

  it('gibt die Claims eines abgebrochenen Vorgangs frei, auch ohne Freigabe-Ereignis', async () => {
    const projectId = await newProject();
    const first = await planned(projectId, 'Wird abgebrochen', ['tools/**']);
    const second = await planned(projectId, 'Danach', ['tools/build.ts']);
    await registry.acquire(first);
    expect((await registry.acquire(second)).acquired).toBe(false);

    // Kein registry.release() — nur der Zustandswechsel. Eine vergessene
    // Freigabe darf kein Projekt dauerhaft blockieren (0009).
    await tasks.transition(first, 'aborted');
    expect((await registry.claimsOf(first)).every((c) => c.status === 'released')).toBe(true);
    expect((await registry.acquire(second)).acquired).toBe(true);
  });

  it('lässt eine Neuplanung nach dem roten Pfad erneut anstehen', async () => {
    const projectId = await newProject();
    const first = await planned(projectId, 'Scheitert', ['apps/**']);
    await registry.acquire(first);
    await tasks.transition(first, 'coding');
    await tasks.transition(first, 'red', { reason: 'Testfehler' });
    await tasks.transition(first, 'queued');
    await tasks.transition(first, 'planning');

    // Neuer Schnitt nach den Erkenntnissen — und damit erneut prüfpflichtig.
    await registry.register(first, ['apps/web/**']);
    expect((await registry.claimsOf(first)).every((c) => c.status === 'pending')).toBe(true);
    expect(await registry.heldGlobs(first)).toEqual([]);

    // In der Zwischenzeit hat jemand anders sich die Dateien genommen.
    const second = await planned(projectId, 'Dazwischen', ['apps/web/index.ts']);
    expect((await registry.acquire(second)).acquired).toBe(true);
    expect((await registry.acquire(first)).acquired).toBe(false);
  });

  it('verweigert eine Änderung der Claims, sobald sie belegt sind', async () => {
    const projectId = await newProject();
    const taskId = await planned(projectId, 'Läuft schon', ['src/a.ts']);
    await registry.acquire(taskId);
    await tasks.transition(taskId, 'coding');
    await expect(registry.register(taskId, ['src/**'])).rejects.toBeInstanceOf(ClaimError);
    expect(await registry.heldGlobs(taskId)).toEqual(['src/a.ts']);
  });

  it('beantwortet ein zweites acquire ohne zu schreiben (Neustart-Fall)', async () => {
    const projectId = await newProject();
    const taskId = await planned(projectId, 'Neustart', ['src/**']);
    const first = await registry.acquire(taskId);
    const again = await registry.acquire(taskId);
    expect(again.acquired).toBe(true);
    expect(again.task.version).toBe(first.task.version);
  });

  it('lässt eine Aufgabe ohne Claims durch, und verbietet ihr jeden Schreibzugriff', async () => {
    const projectId = await newProject();
    const task = await tasks.create({ projectId, title: 'Recherche' });
    await tasks.transition(task.id, 'planning');
    const result = await registry.acquire(task.id);
    expect(result.acquired).toBe(true);
    expect(result.globs).toEqual([]);
    // §6.6: keine Claims heißt kein Schreibrecht, nicht freie Fahrt.
    expect(await registry.allowsPath(task.id, 'src/index.ts')).toBe(false);
  });

  it('entscheidet den gleichzeitigen Zugriff — genau einer gewinnt', async () => {
    const projectId = await newProject();
    const a = await planned(projectId, 'Gleichzeitig A', ['packages/**']);
    const b = await planned(projectId, 'Gleichzeitig B', ['packages/core/src/index.ts']);

    const [first, second] = await Promise.all([registry.acquire(a), registry.acquire(b)]);
    expect([first.acquired, second.acquired].filter(Boolean)).toHaveLength(1);

    const winner = first.acquired ? a : b;
    expect((await registry.claimsOf(winner)).every((c) => c.status === 'active')).toBe(true);
    expect(await registry.audit(projectId)).toEqual([]);
  });

  /**
   * Der Test darüber beweist die Sperre *nicht*.
   *
   * Zwei `Promise.all`-Aufrufe verschränken sich nur, wenn das Timing es
   * hergibt — mit der Sperre ausgebaut lief er weiterhin grün, weil die zweite
   * Transaktion erst eine neue Verbindung aufbauen musste und die erste in der
   * Zwischenzeit fertig war. Ein Test, der mit und ohne den geprüften
   * Mechanismus besteht, prüft nichts. Also wird die Sperre hier direkt
   * nachgewiesen: eine fremde Transaktion hält sie, und `acquire()` kommt
   * nachweislich nicht durch, solange das so ist.
   */
  it('serialisiert die Belegung über eine Projektsperre', async () => {
    const projectId = await newProject();
    const taskId = await planned(projectId, 'Wartet auf die Sperre', ['src/**']);

    let lockTaken!: () => void;
    const locked = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    let releaseLock!: () => void;
    const releaseSignal = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const holder = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${CLAIM_LOCK_NAMESPACE}, hashtext(${projectId}))`;
      lockTaken();
      await releaseSignal;
    });
    await locked;

    let settled = false;
    const attempt = registry.acquire(taskId).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled, 'acquire() lief trotz gehaltener Projektsperre durch').toBe(false);

    releaseLock();
    await holder;
    expect((await attempt).acquired).toBe(true);
  });

  it('sperrt nur das eigene Projekt', async () => {
    // Sonst stünde die Warteschlange eines Projekts still, weil in einem
    // ganz anderen gerade jemand Dateien belegt.
    const busy = await newProject();
    const other = await newProject();
    const taskId = await planned(other, 'Anderes Projekt', ['src/**']);

    let lockTaken!: () => void;
    const locked = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    let releaseLock!: () => void;
    const releaseSignal = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const holder = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${CLAIM_LOCK_NAMESPACE}, hashtext(${busy}))`;
      lockTaken();
      await releaseSignal;
    });
    await locked;

    expect((await registry.acquire(taskId)).acquired).toBe(true);
    releaseLock();
    await holder;
  });

  /**
   * §9s „tasks waiting **behind** a parked task's claims" — projektweit.
   *
   * Die Betriebsprüfung 767db82c hat P4.G5 daran entwertet: die einzige Stelle,
   * die claim-blockierte Aufgaben kennt, war `blockers()`, und ihr einziger
   * Leser der Ablaufplaner. Die Übersicht baute ihre Liste aus den offenen
   * Eskalationen — also aus den Aufgaben, die *gefragt haben*. Eine nach §10
   * serialisierte Aufgabe erschien überhaupt nicht.
   */
  describe('blockedTasks — wer hinter fremden Claims steht (§9, §15)', () => {
    it('nennt die wartende Aufgabe und den Halter', async () => {
      const projectId = await newProject();
      const halter = await planned(projectId, 'Migration umbauen', ['src/db/**']);
      expect((await registry.acquire(halter)).acquired).toBe(true);
      const wartend = await planned(projectId, 'Tests nachziehen', ['src/db/schema.test.ts']);
      // Der Erwerb scheitert — genau das macht sie zur wartenden.
      expect((await registry.acquire(wartend)).acquired).toBe(false);

      const blockiert = await registry.blockedTasks(projectId);
      expect(blockiert).toHaveLength(1);
      expect(blockiert[0]?.taskId).toBe(wartend);
      expect(blockiert[0]?.title).toBe('Tests nachziehen');
      expect(blockiert[0]?.blockedBy.taskId).toBe(halter);
      expect(blockiert[0]?.blockedBy.title).toBe('Migration umbauen');
      // Die deutsche Begründung, die §9 in die Zeitleiste schreibt.
      expect(blockiert[0]?.blockedBy.reason).toContain('Migration umbauen');
    });

    it('nennt den Halter selbst nicht — er wartet auf niemanden', async () => {
      // Die Verwechslung, die den Fund ausgelöst hat, in der Gegenrichtung:
      // wer die Dateien hält, ist nicht blockiert, auch wenn er geparkt ist.
      const projectId = await newProject();
      const halter = await planned(projectId, 'Hält', ['src/**']);
      await registry.acquire(halter);

      expect(await registry.blockedTasks(projectId)).toEqual([]);
    });

    it('meldet nichts, solange die Muster sich nicht überschneiden', async () => {
      const projectId = await newProject();
      const a = await planned(projectId, 'A', ['src/**']);
      await registry.acquire(a);
      const b = await planned(projectId, 'B', ['docs/**']);
      // Kein Konflikt: b bekommt seine Claims und wartet auf niemanden.
      expect((await registry.acquire(b)).acquired).toBe(true);

      expect(await registry.blockedTasks(projectId)).toEqual([]);
    });

    it('vergisst die Wartenden, sobald der Halter fertig ist', async () => {
      // §10 gibt die Claims beim Merge frei, und die Zeile auf der Übersicht
      // muss dann verschwinden — sonst steht dort dauerhaft eine Blockade, die
      // es nicht mehr gibt.
      const projectId = await newProject();
      const halter = await planned(projectId, 'Halter', ['src/**']);
      await registry.acquire(halter);
      const wartend = await planned(projectId, 'Wartend', ['src/x.ts']);
      await registry.acquire(wartend);
      expect(await registry.blockedTasks(projectId)).toHaveLength(1);

      await registry.release(halter, 'merged');
      expect(await registry.blockedTasks(projectId)).toEqual([]);
    });

    it('zählt eine wartende Aufgabe einmal, auch bei zwei Haltern', async () => {
      // Zwei Zeilen für dieselbe Aufgabe wären zwei `<li>` mit demselben
      // React-Key — der Defekt, den A81 auf der Zählerseite behoben hat.
      const projectId = await newProject();
      const a = await planned(projectId, 'Halter A', ['src/a/**']);
      await registry.acquire(a);
      const b = await planned(projectId, 'Halter B', ['src/b/**']);
      await registry.acquire(b);
      const wartend = await planned(projectId, 'Wartend', ['src/a/x.ts', 'src/b/y.ts']);
      await registry.acquire(wartend);

      const blockiert = await registry.blockedTasks(projectId);
      expect(blockiert).toHaveLength(1);
      expect(blockiert[0]?.taskId).toBe(wartend);
    });
  });

  it('prüft Schreibpfade gegen die belegten Muster (§6.6)', async () => {
    const projectId = await newProject();
    const taskId = await planned(projectId, 'Schreibgrenze', ['packages/core/src/**']);
    await registry.acquire(taskId);

    expect(await registry.allowsPath(taskId, 'packages/core/src/deep/file.ts')).toBe(true);
    expect(await registry.allowsPath(taskId, 'packages/web/src/file.ts')).toBe(false);
    expect(await registry.allowsPath(taskId, '../ausserhalb.ts')).toBe(false);
    expect(await registry.allowsPath(taskId, '/etc/passwd')).toBe(false);
  });

  it('erklärt eine erledigte Aufgabe für claim-frei', async () => {
    const projectId = await newProject();
    const taskId = await planned(projectId, 'Fertig', ['README.md']);
    await registry.acquire(taskId);
    for (const state of ['coding', 'review', 'gates', 'merge_queue', 'merging', 'done'] as const) {
      await tasks.transition(taskId, state);
    }
    expect((await registry.claimsOf(taskId)).every((c) => c.status === 'released')).toBe(true);
    await expect(registry.acquire(taskId)).rejects.toBeInstanceOf(ClaimError);
  });
  /**
   * P1.G4s Satz „no orphan claims", nach einem echten Absturz gelesen.
   *
   * Die Betriebsprüfung vom 2026-08-02 hat als `coverage_gap` festgehalten,
   * dass dieser Teil des Hakens von keiner Zusicherung gedeckt war: die
   * Terminal-Fälle sind oben geprüft (`done`, `aborted` ohne Freigabe-Ereignis),
   * aber **kein Beleg las nach einem Absturz je einen Claim**. Genau dort liegt
   * die Gefahr, denn „keine verwaisten Claims" kann auf zwei Arten falsch sein
   * und beide sind schlimm:
   *
   *   * Die Claims **verschwinden** — dann darf eine zweite Aufgabe in dieselben
   *     Dateien, während der halbfertige Arbeitsbaum der ersten noch dort liegt.
   *     Das ist der Fall, den §10 überhaupt verhindern soll.
   *   * Die Claims bleiben **`active`** auf einer Aufgabe, die niemand mehr
   *     ausführt — dann sieht der Planer eine laufende Arbeit, wo eine
   *     abgestürzte steht, und das Projekt steht still, ohne dass es jemandem
   *     auffällt.
   *
   * Richtig ist die dritte Möglichkeit: gehalten und als ausgesetzt erkennbar.
   * §7.2s Integritätsprüfung ist der Weg zurück, und bis dahin gehören die
   * Dateien weiterhin dieser Aufgabe.
   */
  it('hält die Claims über einen Absturz hinweg — weder verloren noch weiter „active"', async () => {
    const projectId = await newProject();
    const taskId = await planned(projectId, 'Stürzt ab', ['src/app.ts']);
    await registry.acquire(taskId);
    await tasks.transition(taskId, 'coding');
    expect((await registry.claimsOf(taskId)).every((c) => c.status === 'active')).toBe(true);

    // Der Absturz: eine Aufgabe mitten in der Arbeit, kein Lauf dazu — genau
    // das, was `reconcile()` beim Daemon-Start vorfindet.
    const result = await reconcile({ sql, tasks, eventLog });
    expect(result.strandedTasks).toContain(taskId);
    expect((await tasks.get(taskId))?.state).toBe('interrupted');

    const danach = await registry.claimsOf(taskId);
    expect(danach).toHaveLength(1);
    // Nicht verloren …
    expect(danach.every((c) => c.status !== 'released')).toBe(true);
    // … und nicht mehr „active", sondern als ausgesetzt lesbar.
    expect(danach.every((c) => c.status === 'parked')).toBe(true);

    // Und die Dateien gehören weiterhin dieser Aufgabe: eine zweite, die
    // dasselbe will, kommt nicht durch.
    const zweite = await planned(projectId, 'Will dieselbe Datei', ['src/app.ts']);
    const konflikt = await registry.blockers(zweite);
    expect(konflikt.map((c) => c.taskId)).toContain(taskId);
    // `acquire` **wirft** hier nicht: nach A45 wird die zweite Aufgabe
    // serialisiert, nicht abgewiesen — sie wartet, und das ist der Unterschied
    // zwischen "blockiert" und "kaputt".
    const versuch = await registry.acquire(zweite);
    expect(versuch.acquired).toBe(false);
  });
});
