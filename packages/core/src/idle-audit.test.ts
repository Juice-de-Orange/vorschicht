/**
 * §21's idle audits, driven with stubs.
 *
 * Three of these assertions are §22's Phase 6 gate sentence taken apart — "idle
 * audit run on a real project yields actionable findings filed as P2 tasks with
 * correct **traces**" — and the third is the one that is easy to lose, because a
 * task with the right title and the right priority looks finished. It is not: a
 * P2 task filed at four in the morning whose `task.created` row does not name
 * the run is a sentence with no author, and the session, its domain and its
 * transcript are all unreachable from it.
 *
 * A17's third condition gets the most cases here, and that is deliberate. Its
 * constant had no reader at all before this file existed — the declaration and
 * nothing else — so every one of these is a first.
 */
import { describe, expect, it } from 'vitest';
import type { EventLog, NewEvent } from './event-log.js';
import {
  assertIdleDomainsRunnable,
  IDLE_AUDIT_DOMAIN_IDS,
  IDLE_AUDIT_DOMAINS,
  IdleAuditService,
  MAX_IDLE_FINDINGS_PER_RUN,
  runnableIdleDomains,
} from './idle-audit.js';
import { AGENT_PROFILES, profileWrites } from './profiles/index.js';
import type { ProjectRecord } from './project-service.js';
import type { AgentRunner } from './runner.js';
import type { CreateTaskSpec } from './task-service.js';

const RUN_ID = 'run-idle-1';

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'p1',
    slug: 'example-app',
    name: 'Example App',
    rootPath: '/projects/example-app',
    readOnly: false,
    selfManaged: false,
    active: true,
    ...overrides,
  } as ProjectRecord;
}

function sample(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    window: 'five_hour',
    modelClass: null,
    usedPercent: 10,
    resetsAt: null,
    source: 'estimated' as const,
    anomaly: null,
    observedAt: 0,
    ...overrides,
  } as never;
}

interface Harness {
  service: IdleAuditService;
  created: CreateTaskSpec[];
  events: NewEvent[];
  warnings: string[];
  rotationRows: Array<{ project_id: string; domain: string; last: Date }>;
}

function harness(
  options: {
    projects?: ProjectRecord[];
    usage?: () => Promise<unknown[]>;
    result?: { status: string; summary: string; followups: string[] };
    runStatus?: 'ok' | 'infra' | 'failed';
    transcriptPath?: string | null;
    sparbetrieb?: () => boolean;
    rotation?: Array<{ project_id: string; domain: string; last: Date }>;
    createThrowsOn?: number;
  } = {},
): Harness {
  const created: CreateTaskSpec[] = [];
  const events: NewEvent[] = [];
  const warnings: string[] = [];
  const rotationRows = options.rotation ?? [];

  // The rotation is one query and the stub answers only it; anything else
  // reaching this tag is a query this suite has not been told about, and it
  // should fail loudly rather than return an empty result that reads as "no
  // history".
  const sql = (() => {
    const fn = (async () => rotationRows) as unknown as Record<string, unknown> &
      ((...args: unknown[]) => Promise<unknown>);
    return fn;
  })() as never;

  const runner = {
    run: async () => {
      const status = options.runStatus ?? 'ok';
      const run = { runId: RUN_ID, transcriptPath: options.transcriptPath ?? '/data/t/run.jsonl' };
      if (status !== 'ok') return { status, run, problem: 'Maschine weg' };
      return {
        status: 'ok',
        run,
        result: options.result ?? {
          status: 'done',
          summary: 'Kurz geprüft.',
          artifacts: [],
          followups: ['src/a.ts:12 — kein Timeout am fetch'],
        },
      };
    },
  } as unknown as AgentRunner;

  const service = new IdleAuditService({
    sql,
    eventLog: {
      append: async (event: NewEvent) => {
        events.push(event);
        return 'e1';
      },
    } as unknown as EventLog,
    runner,
    tasks: {
      create: async (spec: CreateTaskSpec) => {
        created.push(spec);
        if (options.createThrowsOn === created.length) throw new Error('DB weg');
        return { id: `t${created.length}` } as never;
      },
    },
    projects: { listActive: async () => options.projects ?? [project()] },
    usage: (options.usage ?? (async () => [sample()])) as never,
    scratchDir: '/data/runs/idle-audit',
    ...(options.sparbetrieb ? { sparbetrieb: options.sparbetrieb } : {}),
    onWarning: (message) => warnings.push(message),
    now: () => new Date('2026-08-10T09:00:00Z'),
  });

  return { service, created, events, warnings, rotationRows };
}

describe('§21 — die zehn Domänen als Daten', () => {
  it('führt §21s Liste vollständig und in ihrer Reihenfolge', () => {
    expect([...IDLE_AUDIT_DOMAIN_IDS]).toEqual([
      'security',
      'robustness',
      'performance',
      'code_quality',
      'ux',
      'design',
      'a11y',
      'dsgvo',
      'testing',
      'ops',
    ]);
  });

  it('ordnet jede Domäne entweder einem Profil zu oder sagt, worauf sie wartet', () => {
    // Das ist die Zusicherung, die eine still fehlende Domäne findet. Ohne sie
    // liest sich eine Domäne ohne Profil wie eine, die läuft und nichts findet.
    expect(() => assertIdleDomainsRunnable()).not.toThrow();
    for (const id of IDLE_AUDIT_DOMAIN_IDS) {
      const domain = IDLE_AUDIT_DOMAINS[id];
      expect(domain.profile === null, id).toBe(Boolean(domain.availableFrom));
    }
  });

  it('setzt kein schreibendes Profil auf eine nur lesende Prüfung', () => {
    // Die Zusicherung, die §6.6 hier verteidigt: eine schreibende Rolle in
    // einer Leerlauf-Sitzung bekommt jede Änderung verweigert und sieht von
    // außen aus wie eine, die nichts gefunden hat.
    for (const domain of runnableIdleDomains()) {
      const profile = AGENT_PROFILES[domain.profile as NonNullable<typeof domain.profile>];
      expect(profileWrites(profile), `${domain.id} → ${profile.id}`).toBe(false);
    }
    expect(runnableIdleDomains().length).toBeGreaterThan(0);
  });
});

describe('A17 — die dritte Bedingung, und ihr erster Leser', () => {
  it('läuft, wenn jedes Fenster unter der Grenze liegt', async () => {
    const { service } = harness({ usage: async () => [sample({ usedPercent: 49.9 })] });
    const { run, skip } = await service.runOnce();
    expect(skip).toBeNull();
    expect(run?.domain).toBe('security');
  });

  it('läuft nicht bei genau 50 Prozent — die Grenze ist erreicht, nicht unterschritten', async () => {
    const { service } = harness({ usage: async () => [sample({ usedPercent: 50 })] });
    const { run, skip } = await service.runOnce();
    expect(run).toBeNull();
    expect(skip).toEqual({ reason: 'budget', window: 'five_hour', usedPercent: 50 });
  });

  it('fragt jedes Fenster, nicht nur das erste', async () => {
    // §7.1: das engste Fenster gewinnt überall. Ein 5-Stunden-Fenster bei 20 %
    // sagt nichts über ein Wochenfenster bei 60 %.
    const { service } = harness({
      usage: async () => [
        sample({ window: 'five_hour', usedPercent: 20 }),
        sample({ window: 'seven_day', usedPercent: 60 }),
      ],
    });
    const { skip } = await service.runOnce();
    expect(skip).toEqual({ reason: 'budget', window: 'seven_day', usedPercent: 60 });
  });

  it('verweigert bei einem nicht lesbaren Fenster, statt es für leer zu halten', async () => {
    const { service } = harness({
      usage: async () => [sample({ usedPercent: 0, anomaly: { kind: 'unavailable' } })],
    });
    const { run, skip } = await service.runOnce();
    expect(run).toBeNull();
    expect(skip?.reason).toBe('budget_unreadable');
  });

  it('verweigert, wenn es überhaupt keine Messung gibt', async () => {
    const { service } = harness({ usage: async () => [] });
    expect((await service.runOnce()).skip?.reason).toBe('budget_unreadable');
  });

  it('verweigert, wenn die Messung wirft', async () => {
    const { service } = harness({
      usage: async () => {
        throw new Error('Meter weg');
      },
    });
    const { skip } = await service.runOnce();
    expect(skip).toEqual({ reason: 'budget_unreadable', problem: 'Meter weg' });
  });
});

describe('A22 — Sparbetrieb schaltet Leerlauf-Audits ab', () => {
  it('läuft gar nicht und fragt nicht einmal das Budget', async () => {
    let asked = false;
    const { service } = harness({
      sparbetrieb: () => true,
      usage: async () => {
        asked = true;
        return [sample()];
      },
    });
    const { run, skip } = await service.runOnce();
    expect(run).toBeNull();
    expect(skip).toEqual({ reason: 'sparbetrieb' });
    expect(asked).toBe(false);
  });
});

describe('Rotation — am längsten nicht geprüft zuerst', () => {
  it('nimmt bei leerer Historie die erste Domäne aus §21s Liste', async () => {
    const { service } = harness();
    expect((await service.nextSlot())?.domain.id).toBe('security');
  });

  it('überspringt, was gerade geprüft wurde', async () => {
    const { service } = harness({
      rotation: [{ project_id: 'p1', domain: 'security', last: new Date('2026-08-10T08:00:00Z') }],
    });
    expect((await service.nextSlot())?.domain.id).toBe('performance');
  });

  it('gibt einem neuen Projekt seine erste Runde vor der zweiten des alten', async () => {
    const alt = project({ id: 'p1', slug: 'alt' });
    const neu = project({ id: 'p2', slug: 'neu' });
    const rotation = runnableIdleDomains().map((domain, index) => ({
      project_id: 'p1',
      domain: domain.id,
      last: new Date(Date.UTC(2026, 7, 1, index)),
    }));
    const { service } = harness({ projects: [alt, neu], rotation });
    expect((await service.nextSlot())?.project.slug).toBe('neu');
  });

  it('prüft kein Projekt, das auf Nur-Lesen steht (A44.3)', async () => {
    // Seine Funde würden Aufgaben, die der Ablaufplaner nie starten kann — das
    // Loch, das `TickReport.readOnly` sichtbar macht und das dieser Dienst
    // nicht absichtlich füllen darf.
    const { service } = harness({ projects: [project({ readOnly: true })] });
    expect(await service.nextSlot()).toBeNull();
    expect((await service.runOnce()).skip).toEqual({ reason: 'no_project' });
  });

  it('nimmt keine Domäne, die auf ein Profil wartet', async () => {
    const gewählt = new Set<string>();
    const rotation: Array<{ project_id: string; domain: string; last: Date }> = [];
    for (let i = 0; i < runnableIdleDomains().length + 3; i += 1) {
      const { service } = harness({ rotation: [...rotation] });
      const slot = await service.nextSlot();
      if (!slot) break;
      gewählt.add(slot.domain.id);
      rotation.push({
        project_id: 'p1',
        domain: slot.domain.id,
        last: new Date(Date.UTC(2026, 7, 10, i)),
      });
    }
    for (const id of IDLE_AUDIT_DOMAIN_IDS) {
      expect(gewählt.has(id), id).toBe(IDLE_AUDIT_DOMAINS[id].profile !== null);
    }
  });
});

describe('§22s Gate-Satz — Funde werden P2-Aufgaben, und die Spur steht', () => {
  it('legt je Fund genau eine Aufgabe an, mit P2 und der Spur zum Lauf', async () => {
    const { service, created, events } = harness({
      result: {
        status: 'done',
        summary: 'Zwei Stellen ohne Timeout.',
        followups: ['src/a.ts:12 — kein Timeout', 'src/b.ts:40 — kein Timeout'],
      },
    });
    const { run } = await service.runOnce();

    expect(created).toHaveLength(2);
    expect(run?.taskIds).toEqual(['t1', 't2']);
    for (const spec of created) {
      expect(spec.priority).toBe('P2');
      // Die dritte Zusicherung, und die, die man leicht verliert.
      expect(spec.runId).toBe(RUN_ID);
      expect(spec.projectId).toBe('p1');
      expect(spec.type).toBe('idle_audit_finding');
    }
    expect(created[0]?.title).toContain('src/a.ts:12');

    // Und der Lauf trägt seinen Transkriptpfad, sonst endet die Kette aus §18
    // an der Aufgabe.
    const finished = events.find((event) => event.kind === 'idle_audit.finished');
    expect(finished?.runId).toBe(RUN_ID);
    expect(finished?.payload?.transcriptPath).toBe('/data/t/run.jsonl');
    expect(finished?.payload?.findings).toBe(2);
  });

  it('legt keine Aufgabe an, wenn nichts gefunden wurde', async () => {
    // §8.2s Regel, hier geerbt: nichts zu finden ist ein gültiges Ergebnis, und
    // eine Quote erzeugt erfundene Funde.
    const { service, created, events } = harness({
      result: { status: 'done', summary: 'Nichts gefunden.', followups: [] },
    });
    const { run, skip } = await service.runOnce();
    expect(skip).toBeNull();
    expect(created).toHaveLength(0);
    expect(run?.taskIds).toEqual([]);
    expect(events.find((e) => e.kind === 'idle_audit.finished')?.payload?.outcome).toBe('done');
  });

  it('deckelt die Zahl der Aufgaben und sagt, dass gedeckelt wurde', async () => {
    const followups = Array.from({ length: MAX_IDLE_FINDINGS_PER_RUN + 3 }, (_, i) => `f${i}`);
    const { service, created, warnings } = harness({
      result: { status: 'done', summary: 's', followups },
    });
    await service.runOnce();
    expect(created).toHaveLength(MAX_IDLE_FINDINGS_PER_RUN);
    expect(warnings.some((line) => line.includes('nicht als Aufgabe angelegt'))).toBe(true);
    // Und die letzte Aufgabe sagt es auch dort, wo ein Mensch es liest.
    expect(created.at(-1)?.description).toContain('3 weitere');
  });

  it('verliert die anderen Funde nicht, wenn einer nicht angelegt werden kann', async () => {
    const { service, warnings } = harness({
      result: { status: 'done', summary: 's', followups: ['eins', 'zwei'] },
      createThrowsOn: 1,
    });
    const { run } = await service.runOnce();
    expect(run?.taskIds).toEqual(['t2']);
    expect(warnings.some((line) => line.includes('nicht als Aufgabe angelegt werden'))).toBe(true);
  });

  it('macht aus einer gescheiterten Sitzung keine rote Aufgabe', async () => {
    // §21 füllt Lücken; niemand wartet darauf. Eine gescheiterte Sitzung darf
    // deshalb keine Aufgabe, keinen Ops-Alarm und keinen roten Pfad auslösen.
    const { service, created, events } = harness({ runStatus: 'infra' });
    const { run, skip } = await service.runOnce();
    expect(run).toBeNull();
    expect(skip).toEqual({ reason: 'session', status: 'infra', problem: 'Maschine weg' });
    expect(created).toHaveLength(0);
    const finished = events.find((e) => e.kind === 'idle_audit.finished');
    // Trotzdem aufgezeichnet — und die Rotation zählt es mit, damit ein
    // kaputter Rechner nicht alle paar Minuten dieselbe Sitzung kostet.
    expect(finished?.payload?.outcome).toBe('failed');
  });
});

describe('Die Sitzung', () => {
  it('läuft im Kratzverzeichnis, nennt das Projekt absolut und darf nichts schreiben', async () => {
    let seen: Record<string, unknown> | null = null;
    const { service } = harness();
    // Der Runner-Stub oben verrät seine Eingabe nicht, also einer, der es tut.
    const spy = new IdleAuditService({
      sql: (async () => []) as never,
      eventLog: { append: async () => 'e' } as unknown as EventLog,
      runner: {
        run: async (request: Record<string, unknown>) => {
          seen = request;
          return {
            status: 'ok',
            run: { runId: RUN_ID, transcriptPath: null },
            result: { status: 'done', summary: 's', artifacts: [], followups: [] },
          };
        },
      } as unknown as AgentRunner,
      tasks: { create: async () => ({ id: 't' }) as never },
      projects: { listActive: async () => [project()] },
      usage: (async () => [sample()]) as never,
      scratchDir: '/data/runs/idle-audit',
    });
    await spy.runOnce();
    await service.runOnce();

    const request = seen as unknown as Record<string, unknown>;
    expect(request.cwd).toBe('/data/runs/idle-audit');
    expect(request.taskId).toBeNull();
    expect(request.containment).toEqual({ writeRoot: null, claims: null, readOnlyProject: true });
    // A70.1: ein relativer Pfad findet ein leeres Verzeichnis, und die Sitzung
    // meldet dann in gutem Glauben, das Projekt habe keine Tests.
    expect(request.prompt).toContain('/projects/example-app');
    expect(request.prompt).toContain('followups');
  });
});
