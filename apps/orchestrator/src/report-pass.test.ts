/**
 * §16s Wochenbericht-Durchlauf: die vier Aussagen, die er trifft.
 *
 * Rein gehalten — kein Postgres, keine Uhr, kein Generator. Die drei Bausteine
 * darunter haben ihre eigenen Suiten (26 reine Fälle für den Zeitplan, 32 für
 * den Generator, 12 gegen echte Postgres für das Archiv); was **hier** geprüft
 * wird, ist ausschliesslich die Verdrahtung: ruft der Durchlauf im richtigen
 * Moment, mit dem richtigen Fenster, schreibt er genau eine Zeile, und hält er
 * den Tick am Leben, wenn etwas darunter scheitert.
 *
 * Das ist die Trennung, an der dieses Projekt mehrfach gelernt hat: ein
 * Einstiegspunkt ohne Test ist der Ort, an dem ein Aufrufer verschwindet
 * (A86 fand `EscalationMailService.tick()` ohne einen, A83 `buildScheduler` als
 * nicht importierbare Funktion in `main()`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { type ReportPassDeps, runReportPass } from './report-pass.js';

/** Montag, 17.8.2026, 07:00 Europe/Vienna = 05:00 UTC (Sommerzeit). */
const MONTAG_0700 = Date.UTC(2026, 7, 17, 5, 0, 0);
const EINE_STUNDE = 60 * 60 * 1000;

function logger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function eventLog(letzter: number | null) {
  return {
    recentOfKind: vi.fn(async () =>
      letzter === null ? [] : [{ occurredAt: new Date(letzter).toISOString() }],
    ),
    append: vi.fn(
      async (_ereignis: { kind: string; actor: string; payload?: unknown }) => undefined,
    ),
  };
}

function generator(bericht?: Partial<{ bodyText: string }>) {
  return {
    generate: vi.fn(async (fenster: { from: Date; to: Date }) => ({
      fenster,
      periodStart: fenster.from,
      periodEnd: fenster.to,
      subject: 'Vorschicht — Wochenbericht',
      bodyText: bericht?.bodyText ?? 'Kopfzahlen …',
      bodyHtml: '<p>Kopfzahlen …</p>',
      metrics: {},
    })),
  };
}

/**
 * `ReportRecords` wird vom Durchlauf selbst konstruiert (es nimmt nur `sql`),
 * also wird hier die **Datenbankschicht** gefälscht und nicht der Dienst. Das
 * ist absichtlich die unbequemere Variante: eine gefälschte `ReportRecords`
 * würde beweisen, dass der Durchlauf eine Attrappe ruft, die er selbst
 * bekommen hat — eine gefälschte `sql` lässt den echten Dienst laufen.
 */
function sql(verhalten: 'ok' | 'schon_da' | 'kaputt' = 'ok') {
  const aufrufe: unknown[] = [];
  const fn = ((..._teile: unknown[]) => {
    aufrufe.push(_teile);
    if (verhalten === 'schon_da') {
      const fehler: Error & { code?: string; constraint_name?: string } = new Error(
        'duplicate key value violates unique constraint "reports_one_per_period"',
      );
      fehler.code = '23505';
      fehler.constraint_name = 'reports_one_per_period';
      return Promise.reject(fehler);
    }
    if (verhalten === 'kaputt') return Promise.reject(new Error('Verbindung weg'));
    return Promise.resolve([
      {
        id: 'r-1',
        period_start: new Date(MONTAG_0700 - 7 * 24 * EINE_STUNDE),
        period_end: new Date(MONTAG_0700),
        generated_at: new Date(MONTAG_0700),
        subject: 'Vorschicht — Wochenbericht',
        body_text: 'Kopfzahlen …',
        body_html: '<p>Kopfzahlen …</p>',
        metrics: {},
      },
    ]);
  }) as unknown as { (...teile: unknown[]): Promise<unknown>; json(v: unknown): unknown };
  // `ReportRecords.record` ruft `sql.json(...)` für die Kennzahlenspalte. Ohne
  // diese Eigenschaft wirft der echte Dienst mit `this.sql.json is not a
  // function`, der Durchlauf fängt es, und drei Fälle wären rot **ohne dass
  // etwas am Durchlauf falsch wäre**. Genau dieselbe Falle hat am 18.8.2026
  // eine Karte im Posteingang halb angelegt (A144s Nachbar): eine Attrappe,
  // der eine Eigenschaft fehlt, die das echte Gegenstück hat, ist eine
  // Attrappe für etwas anderes (A37s Regel).
  fn.json = (v: unknown) => v;
  return { fn, aufrufe };
}

/**
 * Ein Mailer, der jeden der drei Ausgänge fahren kann (A150).
 *
 * `enabled` ist Teil der Schnittstelle und nicht dekorativ: `createMailer`
 * liefert ohne `SMTP_HOST` einen `DisabledMailer`, und der Durchlauf muss
 * „nicht konfiguriert“ von „abgewiesen“ unterscheiden — sonst liest sich eine
 * frische Anlage wie eine kaputte.
 */
function mailer(verhalten: 'ok' | 'abgewiesen' | 'wirft' | 'aus' = 'ok') {
  // Die Signatur ist deklariert und nicht weggelassen: eine Attrappe ohne
  // Parameter macht `mock.calls` zu einem leeren Tupel, und dann lässt sich
  // nicht prüfen, **was** verschickt wurde — nur dass verschickt wurde (A37).
  const send = vi.fn(async (_mail: { to: string; subject: string; text: string; html: string }) => {
    if (verhalten === 'wirft') throw new Error('Socket weg');
    if (verhalten === 'abgewiesen')
      return { ok: false as const, skipped: false, error: '550 nope' };
    return { ok: true as const };
  });
  return { enabled: verhalten !== 'aus', send };
}

function bau(opts: {
  now: number;
  letzter: number | null;
  db?: 'ok' | 'schon_da' | 'kaputt';
  post?: 'ok' | 'abgewiesen' | 'wirft' | 'aus' | 'keiner';
  empfaenger?: string | undefined;
}) {
  const log = logger();
  const ev = eventLog(opts.letzter);
  const gen = generator();
  const datenbank = sql(opts.db ?? 'ok');
  const post = opts.post && opts.post !== 'keiner' ? mailer(opts.post) : null;
  return {
    log,
    ev,
    gen,
    post,
    // **Eine** Typgrenze, an der Stelle, an der die Attrappen den echten
    // Vertrag betreten — statt vier verstreuter `as never`. Der Grund für den
    // Cast ist echt und nicht Bequemlichkeit: `Queryable` ist der volle
    // postgres-Typ mit rund vierzig Membern, und ihn nachzubauen hiesse, eine
    // Bibliothek zu deklarieren statt einen Durchlauf zu prüfen. Was die
    // Attrappe **wirklich** können muss, steht bei `sql()` darüber und ist an
    // einer gemessenen Falle festgemacht.
    deps: {
      sql: datenbank.fn,
      eventLog: ev,
      generator: gen,
      now: () => opts.now,
      logger: log,
      ...(post ? { mailer: post } : {}),
      ...('empfaenger' in opts ? { recipient: opts.empfaenger } : { recipient: 'max@example.org' }),
    } as unknown as ReportPassDeps,
  };
}

describe('Wochenbericht-Durchlauf (§16, §22 Phase 8)', () => {
  it('tut an sechs von sieben Tagen gar nichts — und zwar ohne eine Zeile zu schreiben', async () => {
    // Mittwoch: der letzte Bericht liegt hinter dem jüngsten Termin.
    const { deps, ev, gen } = bau({
      now: MONTAG_0700 + 2 * 24 * EINE_STUNDE,
      letzter: MONTAG_0700,
    });

    const ergebnis = await runReportPass(deps);

    expect(ergebnis.generated).toBeNull();
    expect(ergebnis.note).toBeNull();
    // Die tragende Hälfte: kein Generator-Lauf und **keine** Ereigniszeile. Ein
    // Durchlauf, der jeden Tick eine Merkzeile schreibt, ist genau der Grund,
    // warum er nicht in `periodic-pass.ts` hängt (A101s Rechnung).
    expect(gen.generate).not.toHaveBeenCalled();
    expect(ev.append).not.toHaveBeenCalled();
  });

  it('erzeugt am fälligen Termin genau einen Bericht und schreibt genau eine Zeile', async () => {
    const { deps, ev, gen } = bau({
      now: MONTAG_0700 + 30 * 1000,
      letzter: MONTAG_0700 - 7 * 24 * EINE_STUNDE,
    });

    const ergebnis = await runReportPass(deps);

    expect(ergebnis.generated).not.toBeNull();
    expect(gen.generate).toHaveBeenCalledTimes(1);
    expect(ev.append).toHaveBeenCalledTimes(1);
    expect((ev.append.mock.calls as unknown[][])[0]?.[0]).toMatchObject({
      kind: 'report.generated',
    });
  });

  it('berichtet über die Woche *vor* dem Termin, auch wenn er nachgeholt wird', async () => {
    // Dienstag nachgeholt: das Fenster muss trotzdem an Montag 07:00 enden,
    // sonst enthielte der Bericht zwei Tage doppelt und der nächste verlöre
    // sie. Das ist die eine Zusicherung, die eine Ableitung aus `now` bricht.
    const { deps, gen } = bau({
      now: MONTAG_0700 + 26 * EINE_STUNDE,
      letzter: MONTAG_0700 - 7 * 24 * EINE_STUNDE,
    });

    await runReportPass(deps);

    const fenster = (gen.generate.mock.calls as unknown[][])[0]?.[0] as { from: Date; to: Date };
    expect(fenster.to.getTime()).toBe(MONTAG_0700);
    expect(fenster.from.getTime()).toBe(MONTAG_0700 - 7 * 24 * EINE_STUNDE);
  });

  it('holt genau einen Bericht nach, wenn der Daemon eine Woche aus war', async () => {
    const { deps, gen, ev } = bau({
      now: MONTAG_0700 + 3 * 24 * EINE_STUNDE,
      letzter: MONTAG_0700 - 21 * 24 * EINE_STUNDE,
    });

    await runReportPass(deps);

    // Einer, nicht drei: die übersprungenen Wochen bekommen keinen eigenen.
    expect(gen.generate).toHaveBeenCalledTimes(1);
    expect(ev.append).toHaveBeenCalledTimes(1);
  });

  it('behandelt eine bereits archivierte Woche als Meldung, nicht als Fehler', async () => {
    const { deps, ev, log } = bau({
      now: MONTAG_0700 + 30 * 1000,
      letzter: MONTAG_0700 - 7 * 24 * EINE_STUNDE,
      db: 'schon_da',
    });

    const ergebnis = await runReportPass(deps);

    expect(ergebnis.generated).toBeNull();
    expect(ergebnis.note).toContain('bereits im Archiv');
    // Und **keine** Ereigniszeile: sonst stünde im Protokoll, ein Bericht sei
    // erzeugt worden, den dieser Lauf nicht geschrieben hat.
    expect(ev.append).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it('nimmt den Tick nicht mit, wenn die Erzeugung scheitert', async () => {
    const { deps, ev, log } = bau({
      now: MONTAG_0700 + 30 * 1000,
      letzter: MONTAG_0700 - 7 * 24 * EINE_STUNDE,
      db: 'kaputt',
    });

    // Wirft nicht: der Wochenbericht ist die unwichtigste Aufgabe des Studios,
    // und dieser Durchlauf hängt im selben Tick wie der Ablaufplaner. Eine
    // unbehandelte Ausnahme hier hielte den Merge-Betrieb an.
    const ergebnis = await runReportPass(deps);

    expect(ergebnis.generated).toBeNull();
    expect(ev.append).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it('main.ts ruft den Durchlauf auf und baut den Generator', () => {
    // Die schwächste Stelle dieser Änderung, hier festgehalten statt
    // stillschweigend hingenommen: `main.ts` hat keinen Test, und genau so kam
    // `EscalationMailService.tick()` dazu, überhaupt keinen Aufrufer zu haben
    // (A86). Dieser grep ersetzt das nicht, er macht nur das Löschen der
    // Aufrufzeile sichtbar.
    //
    // **Zwei** Zusicherungen, weil hier zwei Dinge fehlen können: der Aufruf
    // und der Generator, den er bekommt. Bis heute hatten `metrics`, `records`
    // und `report-schedule` alle drei keinen Aufrufer — A71s Form, dreifach —,
    // und diese beiden Zeilen sind es, die daraus Produktionscode machen.
    const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'main.ts'), 'utf8');

    // `await` mitgeprüft, nicht nur der Name. Die erste Fassung suchte
    // `runReportPass({` — und **überlebte** die Mutation
    // `void 0 && runReportPass({`, weil die Zeichenkette darin weiter vorkommt.
    // Ein Netz, das den abgeschalteten Aufruf für einen Aufruf hält, ist genau
    // die Sorte Zusicherung, die sich wie eine Prüfung liest und keine ist
    // (A74.3). Gefunden durch die ausgeführte Mutation, nicht durch Lesen.
    expect(main).toContain('await runReportPass({');
    expect(main).toContain('new WeeklyReportGenerator({');
  });

  it('liest sein Gedächtnis artengenau, nicht aus den letzten Zeilen aller Arten', async () => {
    const { deps, ev } = bau({ now: MONTAG_0700 + 30 * 1000, letzter: null });

    await runReportPass(deps);

    // A118: `recent()` liest global über alle Arten und verliert das Gedächtnis
    // genau dann, wenn das Studio beschäftigt ist — hier wäre die Folge ein
    // zweiter Bericht für dieselbe Woche.
    expect(ev.recentOfKind).toHaveBeenCalledWith('report.generated', 1);
  });

  /**
   * §16s Zustellung (A150) — vier Ausgänge, und keiner darf wie ein anderer
   * aussehen.
   *
   * Bis zum 25.8.2026 gab es keinen: der Bericht entstand, wurde archiviert und
   * blieb liegen. Das war eine bewusste Entscheidung („ein Durchlauf, der still
   * eine Mail baut und verwirft, sähe aus wie einer, der zugestellt hat“) — und
   * sie gilt weiter für den **unkonfigurierten** Fall, der jetzt sein eigener
   * Ausgang ist statt der einzige.
   */
  describe('Zustellung (§16, A150)', () => {
    it('stellt zu und schreibt genau dafür eine Zeile', async () => {
      const { deps, ev, post } = bau({ now: MONTAG_0700 + 30 * 1000, letzter: null, post: 'ok' });

      const ergebnis = await runReportPass(deps);

      expect(ergebnis.delivered).toBe(true);
      expect(post?.send).toHaveBeenCalledTimes(1);
      const mail = post?.send.mock.calls[0]?.[0];
      expect(mail?.to).toBe('max@example.org');
      // Beide Fassungen gehen raus — §16 verlangt HTML **und** Klartext, und
      // eine Zustellung mit nur einer wäre die halbe Erfüllung.
      expect(mail?.text.length).toBeGreaterThan(0);
      expect(mail?.html).toContain('<');
      const arten = ev.append.mock.calls.map((c) => c[0]?.kind);
      expect(arten).toEqual(['report.generated', 'report.sent']);
    });

    it('sagt es, wenn SMTP nicht konfiguriert ist — und meldet das nicht als Fehler', async () => {
      const { deps, ev } = bau({ now: MONTAG_0700 + 30 * 1000, letzter: null, post: 'aus' });

      const ergebnis = await runReportPass(deps);

      // `null`, nicht `false`: nicht versucht ist etwas anderes als gescheitert.
      expect(ergebnis.delivered).toBeNull();
      expect(ergebnis.note).toContain('SMTP_HOST');
      expect(ev.append.mock.calls.map((c) => c[0]?.kind)).toEqual(['report.generated']);
    });

    it('behandelt einen fehlenden Empfänger genauso', async () => {
      const { deps } = bau({
        now: MONTAG_0700 + 30 * 1000,
        letzter: null,
        post: 'ok',
        empfaenger: undefined,
      });
      const ergebnis = await runReportPass(deps);
      expect(ergebnis.delivered).toBeNull();
    });

    /**
     * Die tragende Zusicherung. Das Gedächtnis des Zeitplans ist
     * `report.generated`; würde die Zeile erst **nach** erfolgreichem Versand
     * geschrieben, käme bei jedem SMTP-Ausfall im nächsten Tick ein neuer
     * Bericht für dieselbe Woche — und der Archivindex wiese ihn ab, sodass der
     * Durchlauf dauerhaft „liegt bereits im Archiv“ meldete. Ein Fehler, der
     * sich als Normalzustand tarnt.
     */
    it('archiviert und merkt sich den Bericht auch dann, wenn die Zustellung scheitert', async () => {
      for (const fall of ['abgewiesen', 'wirft'] as const) {
        const { deps, ev } = bau({ now: MONTAG_0700 + 30 * 1000, letzter: null, post: fall });

        const ergebnis = await runReportPass(deps);

        expect(ergebnis.delivered, fall).toBe(false);
        expect(ergebnis.generated, fall).not.toBeNull();
        const arten = ev.append.mock.calls.map((c) => c[0]?.kind);
        // `report.generated` **ja**, `report.sent` **nein** — genau so herum.
        expect(arten, fall).toEqual(['report.generated']);
        expect(ergebnis.note, fall).toContain('Zustellung fehlgeschlagen');
      }
    });
  });
});
