import { useEffect, useState } from 'react';

/**
 * What the build is doing, and what it wants from you.
 *
 * This panel exists because the build reported to four places at once —
 * the build log, the git log, JSONL transcripts and a Markdown section — all
 * of them on the machine doing the building. Four places to look is the same as
 * none.
 *
 * It is honest about not knowing: a report that never arrived, or arrived half
 * an hour ago, says so rather than presenting a stale phase as the present.
 */

interface BuildReport {
  reportedAt: string;
  phase: string;
  step: string | null;
  gates: { green: number; deferred: number; open: number };
  commits: number;
  head: { sha: string | null; subject: string | null };
  loopRunning: boolean;
  questions: string[];
  stale: boolean;
}

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'gerade eben';
  if (minutes < 60) return `vor ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `vor ${hours} h` : `vor ${Math.round(hours / 24)} Tagen`;
}

export function Build() {
  const [report, setReport] = useState<BuildReport | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch('/api/build', { credentials: 'same-origin' });
        if (!response.ok) return;
        const body = (await response.json()) as BuildReport | null;
        if (!cancelled) {
          setReport(body);
          setLoaded(true);
        }
      } catch {
        if (!cancelled) setLoaded(true);
      }
    };
    void load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!loaded) return null;

  if (!report) {
    return (
      <section className="karte">
        <h2>Bau</h2>
        <p data-testid="build-silent">
          Der Bau hat sich noch nicht gemeldet. Das heißt nicht, dass alles ruhig ist — nur, dass
          von hier aus nichts zu sehen ist.
        </p>
      </section>
    );
  }

  const total = report.gates.green + report.gates.deferred + report.gates.open;

  return (
    <section className="karte">
      <h2>Bau</h2>

      <p data-testid="build-phase">
        <strong>{report.phase}</strong>
        {report.loopRunning ? ' · baut gerade' : ' · steht'}
        {report.stale && ' · Meldung veraltet'}
      </p>

      {report.step && <p data-testid="build-step">Nächster Schritt: {report.step}</p>}

      <p data-testid="build-gates">
        Gates: <strong>{report.gates.green}</strong> grün
        {report.gates.deferred > 0 && <> · {report.gates.deferred} verschoben</>} ·{' '}
        {report.gates.open} offen{total > 0 && <> von {total}</>}
      </p>

      <p data-testid="build-head">
        {report.commits} Commits · zuletzt {report.head.sha ?? '—'}
        {report.head.subject && `: ${report.head.subject}`}
        {' · '}
        {ago(report.reportedAt)}
      </p>

      <h3>Wartet auf dich</h3>
      {report.questions.length === 0 ? (
        <p data-testid="no-questions" className="leise">
          Nichts — der Bau kommt gerade allein weiter.
        </p>
      ) : (
        <ul data-testid="questions" className="liste">
          {report.questions.map((question) => (
            <li key={question}>{question}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
