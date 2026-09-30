import type { OverviewDeployView } from '@vorschicht/shared/inbox';
import { describe, expect, it } from 'vitest';
import {
  healthzKachel,
  kandidatZeile,
  laufzeit,
  liesHealthz,
  rolloutZeile,
  warteschlangeText,
} from './overview-format.js';

/**
 * §17.1s drei fehlende Abschnitte, in ihrer prüfbaren Hälfte.
 *
 * Was hier steht, hat je einen Fehlermodus, der ohne Test unsichtbar ist: eine
 * Gesundheitskachel, die bei Nichterreichbarkeit schweigt; eine gedeckelte
 * Warteschlange, die sich als vollständig liest; und ein Rollback, dessen Ziel
 * als uuid erscheint (A95.4).
 */

const rollout = (
  patch: Partial<OverviewDeployView['deployment']> & { projectSlug?: string | null },
): OverviewDeployView => {
  const { projectSlug, ...deploy } = patch;
  return {
    projectId: 'p1',
    projectSlug: projectSlug === undefined ? 'vorschicht' : projectSlug,
    deployment: {
      id: 'd1',
      sha: 'abcdef0123456789',
      method: 'compose',
      artifact: 'image:abcdef0123',
      outcome: 'succeeded',
      lastStep: 'succeeded',
      startedAt: '2026-08-18T08:00:00.000Z',
      finishedAt: '2026-08-18T08:02:00.000Z',
      durationMs: 120_000,
      problem: null,
      rolledBackTo: null,
      taskId: null,
      ...deploy,
    },
  };
};

describe('die Gesundheitskachel aus /healthz', () => {
  /**
   * Der Fall, für den diese Kachel existiert. Ist `/api/overview` tot, ist die
   * Seite leer — und eine Kachel, die dann schweigt, ist von einer gesunden
   * Anwendung nicht zu unterscheiden.
   */
  it('meldet einen Fehler, wenn der Endpunkt gar nicht antwortet', () => {
    const kachel = healthzKachel(null, 'Failed to fetch');
    expect(kachel.state).toBe('fehler');
    expect(kachel.detail).toContain('/healthz');
    expect(kachel.detail).toContain('Failed to fetch');
  });

  it('unterscheidet „noch nicht gefragt" von „gefragt, keine Antwort"', () => {
    expect(healthzKachel(null, null).state).toBe('unbekannt');
    expect(healthzKachel(null, 'ECONNREFUSED').state).toBe('fehler');
  });

  it('nennt die Datenbank, wenn der Prozess läuft und sie nicht antwortet', () => {
    const kachel = healthzKachel(
      { status: 'degraded', uptimeSeconds: 90, checks: { database: 'error' } },
      null,
    );
    expect(kachel.state).toBe('fehler');
    expect(kachel.detail).toContain('Datenbank');
  });

  it('ist grün, wenn beides antwortet, und sagt seit wann', () => {
    const kachel = healthzKachel(
      { status: 'ok', uptimeSeconds: 7200, checks: { database: 'ok' } },
      null,
    );
    expect(kachel.state).toBe('ok');
    expect(kachel.detail).toContain('2 Stunden');
  });

  /**
   * §8.2s sechste Domäne, mechanisch: ein Bericht, dessen Prüfungen alle grün
   * sind, dessen Gesamtstatus aber nicht „ok" lautet, ist eine Uneinigkeit
   * zwischen zwei Hälften dieses Systems — und die beruhigende Lesart wäre die
   * falsche.
   */
  it('verschweigt ein „degraded" nicht, nur weil jede einzelne Prüfung grün ist', () => {
    const kachel = healthzKachel(
      { status: 'degraded', uptimeSeconds: 10, checks: { database: 'ok' } },
      null,
    );
    expect(kachel.state).toBe('warnung');
  });

  it('parst statt zu casten und sagt auf Deutsch, wenn die Form nicht stimmt', () => {
    expect(liesHealthz({ status: 'ok', uptimeSeconds: 1, checks: { database: 'ok' } }).ok).toBe(
      true,
    );
    const kaputt = liesHealthz({ status: 'ok', checks: {} });
    expect(kaputt.ok).toBe(false);
    if (!kaputt.ok) expect(kaputt.fehler).toContain('vereinbarte Form');
  });
});

describe('laufzeit', () => {
  it('rechnet in Minuten, Stunden und Tagen', () => {
    expect(laufzeit(600)).toBe('10 Minuten');
    expect(laufzeit(3 * 3600)).toBe('3 Stunden');
    expect(laufzeit(5 * 86_400)).toBe('5 Tagen');
  });

  it('erfindet keine Zahl für einen unbrauchbaren Wert', () => {
    expect(laufzeit(Number.NaN)).toBe('unbekannter Zeit');
    expect(laufzeit(-1)).toBe('unbekannter Zeit');
  });
});

describe('§10s Warteschlange auf der Übersicht', () => {
  const kandidat = (position: number, projectId = 'p1', projectSlug: string | null = 'a') => ({
    taskId: `t${position}${projectId}`,
    title: 'Etwas',
    projectId,
    projectSlug,
    priority: 'P2' as const,
    branch: null,
    enteredAt: null,
    position,
  });

  it('schweigt bei leerer Warteschlange', () => {
    expect(warteschlangeText({ candidates: [], total: 0 })).toBeNull();
  });

  /**
   * Die tragende Zusicherung: eine gedeckelte Liste, die sich als vollständige
   * Antwort liest, ist das Einzige, was eine Warteschlange nie tun darf.
   */
  it('sagt, dass die Liste gedeckelt ist, und um wie viel', () => {
    const text = warteschlangeText({ candidates: [kandidat(1), kandidat(2)], total: 11 });
    expect(text).toBe('11 Kandidaten warten auf den Merge — die vordersten 2, 9 weitere');
  });

  it('hängt nichts an, wenn die Liste vollständig ist', () => {
    expect(warteschlangeText({ candidates: [kandidat(1)], total: 1 })).toBe(
      '1 Kandidat wartet auf den Merge',
    );
  });

  it('nennt das Projekt neben der Position, weil die Position projektintern ist', () => {
    expect(kandidatZeile(kandidat(2, 'p2', 'example-app'))).toBe('2. in example-app · P2');
  });

  it('sagt „unbekanntes Projekt" statt eine Zahl ohne Bezug zu drucken', () => {
    expect(kandidatZeile(kandidat(1, 'p3', null))).toContain('unbekanntes Projekt');
  });
});

describe('§12s Rollouts auf der Übersicht', () => {
  it('nennt einen laufenden Rollout „läuft" und nicht erfolgreich', () => {
    const zeile = rolloutZeile(rollout({ outcome: null, lastStep: 'swapped' }));
    expect(zeile).toContain('läuft');
    expect(zeile).not.toContain('ausgerollt');
  });

  /**
   * A95.4: das Rollback-Ziel wird **aufgelöst** dargestellt. Eine uuid an dieser
   * Stelle sieht aus wie eine Antwort und ist keine.
   */
  it('löst das Rollback-Ziel auf, statt seine Kennung zu drucken', () => {
    const zeile = rolloutZeile(
      rollout({
        outcome: 'rolled_back',
        rolledBackTo: {
          deploymentId: '3f6c1a2e-0000-4000-8000-000000000001',
          sha: 'aaaaaaaaaabbbbbbbbbb',
          artifact: 'image:gut',
        },
      }),
    );
    expect(zeile).toContain('zurückgerollt auf aaaaaaaaaa (image:gut)');
    expect(zeile).not.toContain('3f6c1a2e');
  });

  it('sagt es, wenn das Ziel von hier aus nicht benennbar ist', () => {
    const zeile = rolloutZeile(
      rollout({
        outcome: 'rolled_back',
        rolledBackTo: {
          deploymentId: '3f6c1a2e-0000-4000-8000-000000000002',
          sha: null,
          artifact: null,
        },
      }),
    );
    expect(zeile).toContain('nicht benannt werden kann');
    expect(zeile).not.toContain('3f6c1a2e');
  });
});
