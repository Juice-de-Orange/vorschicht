/**
 * §18s Betriebsfakten für die Oberfläche: der Zustand der nächtlichen Sicherung
 * (§18, A14, A103) und der Plattendruck (§18, A30).
 *
 * Beide werden vom Daemon gemessen und landen als Zeilen in `event_log`
 * (`backup.succeeded` / `backup.failed`, `disk.checked`). Bis hierher hatte
 * keiner der beiden einen **Leser**: §18 verlangt eine Ops-Kachel und A103s
 * Vorfall — vier Nächte lang eine 130 Byte grosse Transkript-Sicherung, von
 * niemandem bemerkt — ist genau der Fall, für den sie gebaut wurde. Ein Ereignis
 * mit Erzeuger und ohne Leser ist §8.2s sechste Domäne; dieses Modul ist die
 * fehlende Hälfte.
 *
 * Zwei Leser, ein Erzeuger: die Übersicht zeigt je eine Kachel (§17.1), die
 * Einstellungsseite die Sicherung im Detail (§17.9). Beide lesen dieselben
 * Funktionen hier, weil zwei Ableitungen derselben Tatsache genau so lange
 * übereinstimmen, bis jemand eine davon ändert (A81).
 *
 * Fünf Entscheidungen.
 *
 *  1. **Alter verschlechtert eine Kachel, es verbessert sie nie.** Der Ausfall,
 *     den A103 beschreibt, erzeugt keine Fehlermeldung — er erzeugt *Stille*:
 *     stirbt der Sidecar ganz, bleibt die letzte Zeile für immer `ok` und eine
 *     Kachel, die nur die letzte Zeile liest, meldet für immer Ruhe. Also ist
 *     eine veraltete Erfolgsmeldung eine Warnung. Umgekehrt macht Alter aus
 *     einem Alarm nie eine Unbekanntheit: ein alter Alarm ist immer noch ein
 *     Alarm, und ihn wegen seines Alters herunterzustufen wäre die eine
 *     Richtung, in der eine Sicherheitsanzeige nicht irren darf.
 *
 *  2. **Keine Messung ist `unbekannt`, niemals `ok`.** A83.6, A99.4 und A104.4
 *     sind derselbe Satz dreimal: „wir konnten nicht nachsehen" und „es ist in
 *     Ordnung" sind für ein System, das sich entschieden hat, nicht hinzusehen,
 *     dieselbe Antwort. Eine frische Installation trägt hier also zwei graue
 *     Kacheln und keine grünen.
 *
 *  3. **Die Sätze sind deutsch und fertig** (§2), wie `guardian.text` es
 *     vormacht. Sie sagen bei jedem Zustand, was als Nächstes zu tun wäre — eine
 *     Kachel, die nur meldet, erzeugt die Ratlosigkeit, gegen die §17.1 gebaut
 *     ist.
 *
 *  4. **Die Teilergebnisse der Sicherung reisen mit.** Der Ausfall war ein
 *     *partieller*: `pg_dump` und das Docs-Archiv liefen, das Transkript-Archiv
 *     nicht. „Die Sicherung ist fehlgeschlagen" hätte die eine Tatsache
 *     verborgen, auf die es ankam, und genau deshalb schreibt `backup-pass.ts`
 *     die Komponenten einzeln in die Nutzlast.
 *
 *  5. **Nichts hier misst selbst.** Kein `statfs`, kein Dateizugriff, keine
 *     Prüfung eines Archivs. Der Daemon misst, dieses Modul liest — der Server
 *     hat die Volumes gar nicht gemountet, und eine zweite Messung wäre eine
 *     zweite Wahrheit über denselben Datenträger.
 */
import type { HealthTileView } from '@vorschicht/shared/inbox';
import type postgres from 'postgres';

/** Die Komponenten, die `backup-run.sh` einzeln meldet (A103, `backup-pass.ts`). */
export const SICHERUNG_KOMPONENTEN = ['db', 'docs', 'transcripts', 'prune'] as const;
export type SicherungKomponente = (typeof SICHERUNG_KOMPONENTEN)[number];

/** Deutsch (§2) — wie die Komponenten auf der Einstellungsseite heissen. */
export const SICHERUNG_KOMPONENTEN_LABELS: Record<SicherungKomponente, string> = {
  db: 'Datenbank',
  docs: 'Dokumente',
  transcripts: 'Transkripte',
  prune: 'Aufräumen',
};

/**
 * Ab wann eine **erfolgreiche** Sicherung als veraltet gilt.
 *
 * A14 sichert nächtlich um 02:30, also liegt zwischen zwei Läufen höchstens ein
 * Tag. 36 Stunden lassen eine ganze Nacht Spielraum, bevor die Kachel warnt —
 * genug, dass ein einzelner verspäteter Lauf keinen Fehlalarm erzeugt, und
 * knapp genug, dass A103s stiller Ausfall am zweiten Tag auffällt statt am
 * siebten.
 */
export const SICHERUNG_VERALTET_MS = 36 * 60 * 60_000;

/**
 * Ab wann eine Plattenmessung als veraltet gilt.
 *
 * `DISK_CHECK_INTERVAL_MS` ist eine Stunde; sechs geben fünf ausgelassene Läufe
 * Spielraum. Die Zahl steht hier und nicht im Daemon, weil sie eine Aussage
 * dieser Kachel ist und keine des Messers — der Daemon darf sein Intervall
 * ändern, ohne dass die Oberfläche stillschweigend etwas anderes behauptet.
 */
export const PLATTE_VERALTET_MS = 6 * 60 * 60_000;

export interface SicherungBeobachtung {
  outcome: 'ok' | 'failed';
  /** Wann die Zeile geschrieben wurde. */
  occurredAt: Date;
  /** Was der Sidecar selbst als Endzeit meldete (Epoch-Sekunden), falls er es tat. */
  finishedAt: number | null;
  stamp: string | null;
  components: Partial<Record<SicherungKomponente, string>>;
  problem: string | null;
}

export interface PlatteBeobachtung {
  occurredAt: Date;
  level: 'ok' | 'warning' | 'alert';
  worstPercent: number | null;
  worstPath: string | null;
  /** Pfade, die der Daemon nicht lesen konnte. Nie „in Ordnung" (Entscheidung 2). */
  unreadable: string[];
}

interface EventRow {
  kind: string;
  occurred_at: Date;
  payload: Record<string, unknown>;
}

/**
 * Die jüngste Sicherungsmeldung, oder null.
 *
 * Beide Arten in einer Abfrage: gefragt ist „was ist zuletzt passiert", und zwei
 * Abfragen mit je einem `LIMIT 1` würden bei einer Erholung die ältere
 * Fehlermeldung zurückgeben, weil sie in ihrer eigenen Abfrage die neueste ist.
 */
export async function readSicherung(sql: postgres.Sql): Promise<SicherungBeobachtung | null> {
  const rows = await sql<EventRow[]>`
    SELECT kind, occurred_at, payload FROM event_log
    WHERE kind IN ('backup.succeeded', 'backup.failed')
    ORDER BY id DESC LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const finishedAt = Number(row.payload.finishedAt);
  return {
    outcome: row.kind === 'backup.succeeded' ? 'ok' : 'failed',
    occurredAt: row.occurred_at,
    finishedAt: Number.isFinite(finishedAt) && finishedAt > 0 ? finishedAt : null,
    stamp: typeof row.payload.stamp === 'string' ? row.payload.stamp : null,
    components: (row.payload.components ?? {}) as SicherungBeobachtung['components'],
    problem: typeof row.payload.problem === 'string' ? row.payload.problem : null,
  };
}

/** Die jüngste Plattenmessung, oder null. */
export async function readPlatte(sql: postgres.Sql): Promise<PlatteBeobachtung | null> {
  const rows = await sql<EventRow[]>`
    SELECT kind, occurred_at, payload FROM event_log
    WHERE kind = 'disk.checked'
    ORDER BY id DESC LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const level = row.payload.level;
  const percent = Number(row.payload.worstDisplayPercent ?? row.payload.worstPercent);
  const unreadable = Array.isArray(row.payload.unreadable) ? row.payload.unreadable : [];
  return {
    occurredAt: row.occurred_at,
    // Ein Wert, den dieser Leser nicht kennt, ist nicht „ok": die beiden Hälften
    // wären dann verschiedener Meinung darüber, was gemessen wurde, und die
    // beruhigende Lesart wäre die falsche (Entscheidung 2).
    level: level === 'ok' || level === 'warning' || level === 'alert' ? level : 'warning',
    worstPercent: Number.isFinite(percent) ? percent : null,
    worstPath: typeof row.payload.worstPath === 'string' ? row.payload.worstPath : null,
    unreadable: unreadable.filter((entry): entry is string => typeof entry === 'string'),
  };
}

/** „vor 3 Stunden" / „vor 2 Tagen" — grob, weil genauer hier nichts hilft. */
export function alter(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'zu einem unbekannten Zeitpunkt';
  const minuten = Math.round(ms / 60_000);
  if (minuten < 2) return 'gerade eben';
  if (minuten < 90) return `vor ${minuten} Minuten`;
  const stunden = Math.round(minuten / 60);
  if (stunden < 48) return `vor ${stunden} Stunden`;
  return `vor ${Math.round(stunden / 24)} Tagen`;
}

/**
 * Die Sicherungskachel (§18, A14, A103).
 *
 * Die veraltete Erfolgsmeldung ist der ganze Punkt: sie ist der Zustand, den
 * A103 sieben Nächte lang hatte, und die einzige Form, in der ein toter Sidecar
 * sichtbar wird.
 */
export function sicherungKachel(
  beobachtung: SicherungBeobachtung | null,
  jetzt: number,
): HealthTileView {
  const label = 'Sicherung';
  if (!beobachtung) {
    return {
      id: 'sicherung',
      label,
      state: 'unbekannt',
      detail:
        'Es liegt noch keine Meldung einer nächtlichen Sicherung vor (§18, A14). Das heisst ' +
        'nicht, dass nichts gesichert wurde — es heisst, dass niemand nachgesehen hat.',
      at: null,
    };
  }

  const at = beobachtung.occurredAt.toISOString();
  const seit = jetzt - beobachtung.occurredAt.getTime();

  if (beobachtung.outcome === 'failed') {
    const gescheitert = SICHERUNG_KOMPONENTEN.filter(
      (komponente) => beobachtung.components[komponente] === 'failed',
    ).map((komponente) => SICHERUNG_KOMPONENTEN_LABELS[komponente]);
    return {
      id: 'sicherung',
      label,
      state: 'fehler',
      detail:
        `Die Sicherung ${alter(seit)} ist fehlgeschlagen` +
        (gescheitert.length > 0 ? ` — ${gescheitert.join(', ')}` : '') +
        (beobachtung.problem ? `: ${beobachtung.problem}` : '.') +
        ' Jede weitere Nacht vergrössert den Abstand zu dem, was eine Wiederherstellung ' +
        'bräuchte (§22 Phase 9).',
      at,
    };
  }

  if (seit > SICHERUNG_VERALTET_MS) {
    return {
      id: 'sicherung',
      label,
      state: 'warnung',
      detail:
        `Die letzte vollständige Sicherung war ${alter(seit)} — nächtlich (02:30) wäre sie ` +
        'höchstens einen Tag alt. Es meldet sich also niemand mehr, und das sieht von hier ' +
        'aus genauso aus wie Ruhe (A103).',
      at,
    };
  }

  return {
    id: 'sicherung',
    label,
    state: 'ok',
    detail: `Zuletzt ${alter(seit)} vollständig durchgelaufen${
      beobachtung.stamp ? ` (${beobachtung.stamp})` : ''
    }.`,
    at,
  };
}

/** Die Plattenkachel (§18, A30). */
export function plattenKachel(
  beobachtung: PlatteBeobachtung | null,
  jetzt: number,
): HealthTileView {
  const label = 'Platte';
  if (!beobachtung) {
    return {
      id: 'platte',
      label,
      state: 'unbekannt',
      detail:
        'Es liegt noch keine Messung des Plattenplatzes vor (§18, A30). Der Daemon misst ' +
        'stündlich — bleibt das so, misst gerade niemand.',
      at: null,
    };
  }

  const at = beobachtung.occurredAt.toISOString();
  const seit = jetzt - beobachtung.occurredAt.getTime();
  const wo = beobachtung.worstPath ? ` (${beobachtung.worstPath})` : '';
  const wert =
    beobachtung.worstPercent === null
      ? 'ohne lesbaren Messwert'
      : `bei ${beobachtung.worstPercent} %${wo}`;
  const nichtLesbar =
    beobachtung.unreadable.length > 0 ? ` Nicht lesbar: ${beobachtung.unreadable.join(', ')}.` : '';

  if (beobachtung.level === 'alert') {
    return {
      id: 'platte',
      label,
      state: 'fehler',
      detail:
        `Die vollste überwachte Ablage steht ${wert}. Ab 90 % räumt Vorschicht abgelaufene ` +
        `Rohtranskripte selbst weg (A15, A30) — das Ereignisprotokoll nie.${nichtLesbar}`,
      at,
    };
  }

  if (beobachtung.level === 'warning') {
    return {
      id: 'platte',
      label,
      state: 'warnung',
      detail: `Die vollste überwachte Ablage steht ${wert}, also über der 80-%-Marke (A30).${nichtLesbar}`,
      at,
    };
  }

  // Entscheidung 1: Alter verschlechtert, es verbessert nie — deshalb steht
  // dieser Zweig unter den beiden oberen und nicht über ihnen.
  if (seit > PLATTE_VERALTET_MS) {
    return {
      id: 'platte',
      label,
      state: 'unbekannt',
      detail:
        `Die letzte Messung ist ${alter(seit)} und sagt ${wert}. Gemessen wird stündlich, ` +
        'diese Zahl ist also kein aktueller Zustand mehr.',
      at,
    };
  }

  return {
    id: 'platte',
    label,
    state: 'ok',
    detail: `Alle überwachten Ablagen unter 80 %; die vollste steht ${wert}.${nichtLesbar}`,
    at,
  };
}

/** Beide Kacheln, in der Reihenfolge, in der sie auf der Übersicht stehen. */
export async function healthTiles(sql: postgres.Sql, jetzt: number): Promise<HealthTileView[]> {
  const [sicherung, platte] = await Promise.all([readSicherung(sql), readPlatte(sql)]);
  return [sicherungKachel(sicherung, jetzt), plattenKachel(platte, jetzt)];
}
