/**
 * Everything §17.4's page decides that is not JSX.
 *
 * The parse is the reason this file exists at all. A81's defect was two halves
 * of one payload agreeing on nothing while both were green against their own
 * fixtures, and the fix is that the page *parses* rather than casts — which is
 * only a guarantee if removing the parse fails a test. That is what
 * `leseListe`'s wrong-shape case is for, and it is why the fetch is stubbed
 * rather than the parse called directly.
 */
import type { SpurDiff, SpurTranskript, SpurTranskriptZeile } from '@vorschicht/shared/spuren';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  angezeigteMarken,
  diffKopf,
  diffZusammenfassung,
  ereignisLauf,
  ereignisZeile,
  kurz,
  LEERER_FILTER,
  laufAusgang,
  leerText,
  leseListe,
  listenUrl,
  sichtbareZeilen,
  transkriptKopf,
  verborgeneZeilen,
} from './spuren-format.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function antwortet(koerper: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ json: async () => koerper })),
  );
}

const LEER: SpurTranskript = {
  state: 'present',
  erklaerung: '',
  compressed: false,
  path: null,
  totalLines: 0,
  page: 1,
  pages: 1,
  pageSize: 200,
  lines: [],
  marks: [],
  focus: null,
  focusProblem: null,
};

function zeile(over: Partial<SpurTranskriptZeile>): SpurTranskriptZeile {
  return {
    nr: 1,
    kind: 'assistant',
    titel: 'Assistent',
    text: '',
    truncated: false,
    marks: [],
    ...over,
  };
}

describe('Eine Antwort wird gelesen, nicht behauptet', () => {
  it('liest die Liste aus ihrer Hülle', async () => {
    antwortet({ aufgaben: [], truncated: false, projekte: [] });

    const gelesen = await leseListe(LEERER_FILTER);

    expect(gelesen.ok).toBe(true);
  });

  it('sagt auf Deutsch, dass die Form nicht stimmt, statt undefined zu rendern', async () => {
    // Exactly A81's shape: an envelope the page does not expect. Casting would
    // have produced `undefined` in the DOM and a page stuck on "Wird geladen…";
    // parsing produces a sentence somebody can act on.
    antwortet({ spuren: [] });

    const gelesen = await leseListe(LEERER_FILTER);

    expect(gelesen.ok).toBe(false);
    expect(gelesen.ok === false && gelesen.fehler).toContain('nicht die vereinbarte Form');
  });

  it('macht auch aus einer Fehlerantwort des Servers einen Satz', async () => {
    // A non-2xx from this surface still carries `{ errors: [...] }`, and the
    // parse turns it into the page's own sentence rather than a network error.
    antwortet({ errors: ['Aufgabe nicht gefunden'] });

    expect((await leseListe(LEERER_FILTER)).ok).toBe(false);
  });
});

describe('Der Filter', () => {
  it('lässt „alle" und Leeres aus der URL heraus', () => {
    // Absence needs no agreement between the two ends; a parameter carrying the
    // word "alle" would have to be understood identically on both sides.
    expect(listenUrl(LEERER_FILTER)).toBe('/api/aufgaben');
  });

  it('nimmt genau die gesetzten Werte auf', () => {
    const url = listenUrl({ ...LEERER_FILTER, zustand: 'coding', von: '2026-08-01' });

    expect(url).toContain('zustand=coding');
    expect(url).toContain('von=2026-08-01');
    expect(url).not.toContain('prioritaet');
  });

  it('unterscheidet ein leeres Studio von einem zu engen Filter', () => {
    // One wording for both is how "nothing has run yet" comes to mean "your
    // filter is too narrow" — and the other way round, which hides that the
    // studio has been idle.
    expect(leerText(LEERER_FILTER)).toContain('noch keine Aufgaben');
    expect(leerText({ ...LEERER_FILTER, zustand: 'coding' })).toContain('Kein Treffer');
  });
});

describe('Was auf einer Zeitstrahl-Zeile steht', () => {
  it('nennt bei einem Zustandswechsel das Ziel und den angegebenen Grund', () => {
    const text = ereignisZeile({
      kind: 'state_changed',
      state: 'coding',
      actor: 'orchestrator',
      payload: { reason: 'Planung fertig' },
    });

    // A timeline of "Zustandswechsel" seventeen times is a list, not a trace.
    expect(text).toBe('Zustandswechsel → In Umsetzung: Planung fertig');
  });

  it('kommt ohne Grund aus', () => {
    expect(ereignisZeile({ kind: 'note', state: 'coding', actor: 'x', payload: {} })).toBe('Notiz');
  });

  it('findet die Sitzung, auf die ein Eintrag zeigt', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    expect(ereignisLauf({ runId: id })).toBe(id);
    expect(ereignisLauf({ agentRunId: id })).toBe(id);
  });

  it('nimmt keine Kennung an, die keine ist', () => {
    // The link built from this goes straight into a URL; a loose reading would
    // produce a jump target that answers 404.
    expect(ereignisLauf({ runId: 'kaputt' })).toBeNull();
    expect(ereignisLauf({})).toBeNull();
    expect(ereignisLauf(null)).toBeNull();
  });
});

describe('Der Ausgang eines Laufs', () => {
  it('nennt einen unfertigen Lauf „läuft" und niemals „ok"', () => {
    // Derived from what the record says, never stored: `classifyRun`'s five
    // outcomes live in the runner and are not projected, so a second
    // classification here could disagree with the one the scheduler acted on.
    expect(laufAusgang({ finished: false, terminalReason: null, exitCode: null })).toBe('läuft');
  });

  it('unterscheidet einen sauberen Abschluss von einem mit Fehlercode', () => {
    expect(laufAusgang({ finished: true, terminalReason: 'completed', exitCode: 0 })).toBe(
      'abgeschlossen',
    );
    expect(laufAusgang({ finished: true, terminalReason: 'completed', exitCode: 2 })).toBe(
      'beendet mit Fehler',
    );
  });

  it('gibt einen unbekannten Grund unverändert zurück, statt ihn zu glätten', () => {
    // A reason this dashboard does not know is a mismatch between two halves of
    // the system; printing a friendly default would hide exactly that.
    expect(laufAusgang({ finished: true, terminalReason: 'neuer_grund', exitCode: 0 })).toBe(
      'neuer_grund',
    );
  });
});

describe('Der Kopf über dem Sitzungsprotokoll', () => {
  it('nennt eine vorhandene, aber leere Datei als solche', () => {
    // The whole point of the five states: `present` with zero lines is a fact,
    // and it is not the same fact as the file being gone.
    expect(transkriptKopf(LEER)).toContain('keine Zeile');
  });

  it('sagt bei jedem anderen Zustand, warum nichts da ist', () => {
    expect(transkriptKopf({ ...LEER, state: 'expired', erklaerung: 'ist abgelaufen' })).toBe(
      'ist abgelaufen',
    );
  });

  it('nennt Zeilenzahl, Seite und ob es aus dem gepackten Archiv kam', () => {
    const kopf = transkriptKopf({ ...LEER, totalLines: 900, page: 2, pages: 5, compressed: true });

    expect(kopf).toContain('900 Zeilen');
    expect(kopf).toContain('gepacktes Archiv');
    expect(kopf).toContain('Seite 2 von 5');
  });
});

describe('Der Gesprächsfilter', () => {
  const zeilen = [
    zeile({ nr: 1, kind: 'assistant' }),
    zeile({ nr: 2, kind: 'bookkeeping' }),
    zeile({ nr: 3, kind: 'tool_use' }),
    zeile({ nr: 4, kind: 'system' }),
  ];

  it('zeigt ausgeschaltet jede Zeile', () => {
    // §18 makes this file the evidence; hiding rows by default would decide for
    // the auditor what the session consisted of.
    expect(sichtbareZeilen(zeilen, false)).toHaveLength(4);
    expect(verborgeneZeilen(zeilen, false)).toBe(0);
  });

  it('blendet eingeschaltet die Buchführung aus und sagt wie viel', () => {
    expect(sichtbareZeilen(zeilen, true).map((z) => z.nr)).toEqual([1, 3]);
    expect(verborgeneZeilen(zeilen, true)).toBe(2);
  });
});

describe('Die Sprungmarken', () => {
  const viele = [
    ...Array.from({ length: 40 }, (_, i) => ({ nr: i + 1, kind: 'tool' as const, titel: 't' })),
    { nr: 99, kind: 'decision' as const, titel: 'die Frage' },
  ];

  it('hält die Entscheidung in der Liste, auch wenn sie hinter dem Deckel läge', () => {
    // The mark §22's exit gate addresses must never fall off the end. Without
    // this, a session that makes forty tool calls before it asks a question
    // leaves the fallback route to its decision line behind a page-through.
    const gezeigt = angezeigteMarken(viele);

    expect(gezeigt[0]).toMatchObject({ nr: 99, kind: 'decision' });
    expect(gezeigt).toHaveLength(25);
  });

  it('zeigt mehr als den Deckel, wenn es mehr Entscheidungen als Plätze gibt', () => {
    const nurEntscheidungen = Array.from({ length: 30 }, (_, i) => ({
      nr: i + 1,
      kind: 'decision' as const,
      titel: 'f',
    }));

    expect(angezeigteMarken(nurEntscheidungen)).toHaveLength(30);
  });

  it('deckelt alles andere', () => {
    expect(angezeigteMarken(viele.slice(0, 40))).toHaveLength(25);
  });
});

describe('Der Vergleich', () => {
  const basis: SpurDiff = {
    ok: true,
    problem: null,
    erklaerung: '',
    basis: 'merge',
    fromRef: 'a'.repeat(40),
    toRef: 'b'.repeat(40),
    forkPoint: false,
    files: [],
    truncated: false,
  };

  it('sagt, welche zwei Stände verglichen wurden', () => {
    const kopf = diffKopf(basis);

    expect(kopf).toContain('Merge-Warteschlange');
    expect(kopf).toContain('→');
    expect(kopf).toContain('aaaaaaaaaaaa');
  });

  it('zeigt einen Abzweigpunkt anders an als ein Sha-Paar', () => {
    // The two are different comparisons, and an empty file list means something
    // different in each — so the page must not render them identically.
    expect(
      diffKopf({ ...basis, basis: 'branch', fromRef: 'main', toRef: 'x', forkPoint: true }),
    ).toContain('…');
  });

  it('kürzt ein Sha, lässt einen Zweignamen aber ganz', () => {
    // Cutting a branch name to twelve characters produces a string that looks
    // like a sha and names nothing.
    expect(kurz('a'.repeat(40))).toBe('aaaaaaaaaaaa');
    expect(kurz('vorschicht/task-1')).toBe('vorschicht/task-1');
    expect(kurz(null)).toBe('—');
  });

  it('nennt einen leeren Vergleich als solchen, nicht als Fehler', () => {
    // "This task changed nothing" is a real answer and has to be
    // distinguishable from every refusal.
    expect(diffZusammenfassung(basis)).toContain('keine Änderung');
  });

  it('zählt Dateien und Zeilen zusammen', () => {
    const summe = diffZusammenfassung({
      ...basis,
      files: [
        { path: 'a.ts', added: 3, removed: 1, binary: false, patch: '', patchTruncated: false },
        { path: 'b.ts', added: 2, removed: 0, binary: false, patch: '', patchTruncated: false },
      ],
    });

    expect(summe).toBe('2 Dateien · +5 / −1');
  });

  it('gibt bei einer Absage deren Begründung wieder, nicht eine Null-Bilanz', () => {
    const abgelehnt = diffZusammenfassung({
      ...basis,
      ok: false,
      problem: 'unresolvable',
      erklaerung: 'Die aufgezeichneten Commits sind nicht mehr auflösbar.',
    });

    expect(abgelehnt).toContain('nicht mehr auflösbar');
  });
});
