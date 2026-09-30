/**
 * Der Nachlauf für §8.2s Funde, gegen echte Zeilen (A149).
 *
 * Die Aussage ist eine **Verknüpfung zweier Sichten** — `audit_findings.status`
 * kommt aus `audit_finding_events`, `tasks.state` aus `task_events`, und ob
 * `f.fix_task_id::text = t.id::text` wirklich trifft, weiss nur Postgres. Eine
 * Attrappe würde hier den Join beantworten, den sie prüfen soll.
 *
 * Gesät wird roh statt über `AuditService.run()`: dessen Erzeuger ist eine
 * Modellsitzung, und eine Fixture, die den geprüften Erzeuger benutzt, kann
 * einen Fehler in ihm aufsetzen und im selben Zug bestehen lassen (A95).
 */
import { AuditService } from '@vorschicht/core';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAuditFindingsPass } from './audit-findings-pass.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('runAuditFindingsPass', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let projectId: string;

  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  beforeAll(async () => {
    database = await createTestDatabase('auditfindings');
    sql = createSql({ url: database.url, max: 2 });
    const [row] = await sql<Array<{ id: string }>>`
      INSERT INTO projects (slug, name, root_path) VALUES ('p', 'P', '/projects/p')
      RETURNING id::text
    `;
    projectId = row?.id as string;
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
  });

  /** Eine Aufgabe im gewünschten Endzustand, roh über §9s Zustandskette. */
  async function aufgabe(id: string, ziel: 'done' | 'coding'): Promise<string> {
    const schritte =
      ziel === 'done'
        ? ['planning', 'claimed', 'coding', 'review', 'gates', 'merge_queue', 'merging', 'done']
        : ['planning', 'claimed', 'coding'];
    await sql`
      INSERT INTO task_events (task_id, seq, kind, project_id, state, priority, actor, payload)
      VALUES (${id}, 0, 'created', ${projectId}, 'queued', 'P2', 'system',
              ${sql.json({ title: 'Fixaufgabe' })})
    `;
    let seq = 1;
    for (const state of schritte) {
      await sql`
        INSERT INTO task_events (task_id, seq, kind, project_id, state, priority, actor, payload)
        VALUES (${id}, ${seq}, 'state_changed', ${projectId}, ${state}, 'P2', 'system', '{}'::jsonb)
      `;
      seq += 1;
    }
    return id;
  }

  /** Ein offener Fund mit Fix-Aufgabe, roh gesät. */
  async function fund(findingId: string, auditId: string, fixTaskId: string | null) {
    await sql`
      INSERT INTO audit_finding_events (finding_id, seq, kind, actor, payload)
      VALUES (${findingId}, 0, 'raised', 'auditor',
              ${sql.json({ auditId, domain: 'gate_truth', class: 'defect', summary: 'S', evidence: 'E' })})
    `;
    await sql`
      INSERT INTO audit_finding_events (finding_id, seq, kind, actor, payload)
      VALUES (${findingId}, 1, 'applied', 'orchestrator',
              ${sql.json({ ok: true, note: 'n', fixTaskId })})
    `;
  }

  const dienst = () =>
    new AuditService({
      sql,
      eventLog: { append: async () => 'x' } as never,
      runner: {} as never,
      repoRoot: '/projects/p',
      specPath: '/projects/p/CLAUDE.md',
      scratchDir: '/tmp',
      tasks: {} as never,
      projectId,
    });

  const status = async (id: string) => {
    const [row] = await sql<Array<{ status: string }>>`
      SELECT status FROM audit_findings WHERE id = ${id}
    `;
    return row?.status;
  };

  it('schliesst einen Fund, dessen Fix-Aufgabe fertig ist', async () => {
    const t = await aufgabe(uuid(1), 'done');
    await fund(uuid(101), uuid(900), t);
    expect(await status(uuid(101))).toBe('open');

    const bericht = await runAuditFindingsPass({ sql, audits: dienst() });
    expect(bericht.problem).toBeNull();
    expect(bericht.aufgeloest).toContain(uuid(101));
    expect(await status(uuid(101))).toBe('resolved');
  });

  /**
   * Die Hälfte, die man weglässt — und heute die einzige, die in Produktion
   * eintritt: alle 13 Fix-Aufgaben der offenen Funde stehen `queued` oder
   * `parked`, weil A85 das Projekt auf `read_only` hält.
   */
  it('lässt einen Fund offen, dessen Aufgabe noch läuft', async () => {
    const t = await aufgabe(uuid(2), 'coding');
    await fund(uuid(102), uuid(900), t);

    const bericht = await runAuditFindingsPass({ sql, audits: dienst() });
    expect(bericht.aufgeloest).not.toContain(uuid(102));
    expect(await status(uuid(102))).toBe('open');
  });

  it('fasst einen Fund ohne Fix-Aufgabe nicht an', async () => {
    await fund(uuid(103), uuid(900), null);
    const bericht = await runAuditFindingsPass({ sql, audits: dienst() });
    expect(bericht.aufgeloest).not.toContain(uuid(103));
    expect(await status(uuid(103))).toBe('open');
  });

  it('meldet denselben Fund kein zweites Mal', async () => {
    const t = await aufgabe(uuid(3), 'done');
    await fund(uuid(104), uuid(900), t);

    const erst = await runAuditFindingsPass({ sql, audits: dienst() });
    expect(erst.aufgeloest).toContain(uuid(104));
    const zweit = await runAuditFindingsPass({ sql, audits: dienst() });
    expect(zweit.aufgeloest).not.toContain(uuid(104));
  });

  it('wirft nicht, wenn die Datenbank wegbricht — der Tick darf nicht stehenbleiben', async () => {
    const kaputt = (() => {
      throw new Error('keine Verbindung');
    }) as unknown as postgres.Sql;
    const bericht = await runAuditFindingsPass({ sql: kaputt, audits: dienst() });
    expect(bericht.problem).toContain('keine Verbindung');
    expect(bericht.aufgeloest).toEqual([]);
  });
});
