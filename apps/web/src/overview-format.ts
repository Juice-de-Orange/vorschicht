/**
 * §17.1s Übersicht in reinen Funktionen — Merge-Queue, Rollouts und die
 * Gesundheitskacheln.
 *
 * Dieselbe Anordnung wie `inbox-format.ts`, `quellen-format.ts` und
 * `einstellungen-format.ts`, und aus demselben Grund: `apps/web` hat **keine
 * DOM-Testumgebung** — vitest läuft in `node`, das Repository trägt weder jsdom
 * noch eine Komponententestbibliothek —, also ist eine Regel, die in einer
 * Komponente wohnt, eine Regel, an die nur Playwright herankommt. Was hier
 * steht, kann heute absichtlich kaputtgemacht und rot beobachtet werden.
 *
 * **Die Formen werden nicht hier deklariert.** Sie sind
 * `@vorschicht/shared/inbox`s und werden **geparst**, nie gecastet (A81). Was
 * dieses Modul hinzufügt, ist Deutsch: die Sätze, die Etiketten und der eine
 * Zustand, den der Server nicht kennen kann — dass er selbst nicht antwortet.
 */
import {
  DEPLOY_OUTCOME_LABELS,
  HEALTHZ_PATH,
  type HealthReportView,
  type HealthTileView,
  healthReportView,
  type MergeQueueView,
  type OverviewDeployView,
} from '@vorschicht/shared/inbox';
import { type Gelesen, lies } from './inbox-format.js';

export type { HealthReportView, HealthTileView, MergeQueueView, OverviewDeployView };

/** Der Bericht von `/healthz`, oder ein deutscher Satz über seine Form. */
export function liesHealthz(koerper: unknown): Gelesen<HealthReportView> {
  return lies(healthReportView, koerper, 'die Lebendigkeitsprüfung');
}

/** Deutsch (§2) — der Zustand einer Kachel als Wort, nicht nur als Farbe. */
export const KACHEL_ZUSTAND_LABELS: Record<HealthTileView['state'], string> = {
  ok: 'in Ordnung',
  warnung: 'Warnung',
  fehler: 'Fehler',
  unbekannt: 'unbekannt',
};

/**
 * Die Kachel für Prozess und Datenbank, aus `/healthz`.
 *
 * Sie kommt bewusst **nicht** vom Übersichtsendpunkt. Käme sie von dort, wäre
 * sie aus derselben Abfrage abgeleitet, die die Antwort erzeugt hat — sie könnte
 * dann nie etwas anderes als „ok" sagen, und eine Kachel mit genau einem
 * möglichen Zustand ist §8.2s sechste Domäne mit beruhigendem Gesicht.
 *
 * Der dritte Fall ist der, für den sie existiert: `/api/overview` antwortet
 * nicht. Dann ist die ganze übrige Seite leer, und diese eine Kachel ist das
 * Einzige, was noch etwas sagen kann — sie wird deshalb auch dann gerendert.
 * `null` heisst „noch nicht gefragt" und ist von „gefragt, keine Antwort"
 * unterschieden, weil ein Ladezustand keine Aussage über die Gesundheit ist.
 */
export function healthzKachel(
  bericht: HealthReportView | null,
  problem: string | null,
): HealthTileView {
  const label = 'Anwendung';
  if (problem !== null) {
    return {
      id: 'anwendung',
      label,
      state: 'fehler',
      detail: `Die Anwendung antwortet nicht auf ${HEALTHZ_PATH}: ${problem}`,
      at: null,
    };
  }
  if (bericht === null) {
    return { id: 'anwendung', label, state: 'unbekannt', detail: 'Wird geprüft…', at: null };
  }
  if (bericht.checks.database === 'error') {
    return {
      id: 'anwendung',
      label,
      state: 'fehler',
      detail:
        'Die Anwendung läuft, aber die Datenbank antwortet nicht. Ohne sie ist auf dieser ' +
        'Seite nichts aktuell (§18).',
      at: null,
    };
  }
  if (bericht.status !== 'ok') {
    return {
      id: 'anwendung',
      label,
      state: 'warnung',
      detail: 'Die Anwendung meldet sich als eingeschränkt, nennt aber keine kaputte Prüfung.',
      at: null,
    };
  }
  return {
    id: 'anwendung',
    label,
    state: 'ok',
    detail: `Anwendung und Datenbank antworten; läuft seit ${laufzeit(bericht.uptimeSeconds)}.`,
    at: null,
  };
}

/** „12 Minuten" / „3 Stunden" / „5 Tagen" — der Satzteil nach „seit". */
export function laufzeit(sekunden: number): string {
  if (!Number.isFinite(sekunden) || sekunden < 0) return 'unbekannter Zeit';
  const minuten = Math.floor(sekunden / 60);
  if (minuten < 90) return `${minuten} Minuten`;
  const stunden = Math.round(minuten / 60);
  return stunden < 48 ? `${stunden} Stunden` : `${Math.round(stunden / 24)} Tagen`;
}

/**
 * §10s Warteschlange in einem Satz, oder null wenn sie leer ist.
 *
 * Die gedeckelte Liste sagt, dass sie gedeckelt ist, und sie sagt es aus der
 * **Identität** `total > candidates.length` statt aus einem zweiten Feld — das
 * ist A81.4s Lehre: zwei Ableitungen derselben Tatsache stimmen so lange
 * überein, bis jemand eine ändert. Bei leerer Warteschlange steht hier nichts:
 * ein dauerhaftes „0 Kandidaten" ist eine Zeile, die man zu übersehen lernt,
 * und dann ist die erste echte unsichtbar.
 */
export function warteschlangeText(queue: MergeQueueView): string | null {
  if (queue.total === 0) return null;
  const kopf =
    queue.total === 1
      ? '1 Kandidat wartet auf den Merge'
      : `${queue.total} Kandidaten warten auf den Merge`;
  const rest = queue.total - queue.candidates.length;
  return rest > 0 ? `${kopf} — die vordersten ${queue.candidates.length}, ${rest} weitere` : kopf;
}

/**
 * Eine Warteschlangenzeile, so wie ein Mensch sie liest.
 *
 * Die Position ist projektintern (§10 serialisiert je Projekt), also steht das
 * Projekt daneben — ohne es ist „2." in einer gemischten Liste eine Zahl, die
 * nichts bedeutet.
 */
export function kandidatZeile(kandidat: MergeQueueView['candidates'][number]): string {
  const projekt = kandidat.projectSlug ?? 'unbekanntes Projekt';
  return `${kandidat.position}. in ${projekt} · ${kandidat.priority}`;
}

/**
 * Ein Rollout in einem Satz (§12).
 *
 * Ein laufender Rollout hat **kein** Ergebnis, und das ist eine vierte Antwort
 * und keine fehlende: `lastStep` sagt dann, wie weit er gekommen ist. Eine
 * Seite, die null als „erfolgreich" rendert, meldet einen Tausch, der vielleicht
 * nie stattgefunden hat (`deploymentView`, dieselbe Stelle).
 */
export function rolloutZeile(eintrag: OverviewDeployView): string {
  const projekt = eintrag.projectSlug ?? 'unbekanntes Projekt';
  const deploy = eintrag.deployment;
  const kurz = deploy.sha.slice(0, 10);
  if (deploy.outcome === null) {
    return `${projekt} · ${kurz} · läuft${deploy.lastStep ? ` (${deploy.lastStep})` : ''}`;
  }
  const ergebnis = DEPLOY_OUTCOME_LABELS[deploy.outcome];
  if (deploy.outcome === 'rolled_back') {
    const ziel = deploy.rolledBackTo;
    // A95.4: aufgelöst, nie als uuid. Lässt sich das Ziel von hier aus nicht
    // benennen, sagt die Zeile das — eine Kennung als Antwort auszugeben wäre
    // die eine Form, die wie eine Antwort aussieht und keine ist.
    const wohin =
      ziel === null
        ? ''
        : ziel.sha
          ? ` auf ${ziel.sha.slice(0, 10)}${ziel.artifact ? ` (${ziel.artifact})` : ''}`
          : ' auf ein älteres Release, das von hier aus nicht benannt werden kann';
    return `${projekt} · ${kurz} · ${ergebnis}${wohin}`;
  }
  return `${projekt} · ${kurz} · ${ergebnis}`;
}
