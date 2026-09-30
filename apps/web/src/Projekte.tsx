// The `/gates` subpath rather than the barrel: `@vorschicht/shared` re-exports
// `worktree.js` and `containment.js`, both of which import `node:path`, and
// rollup refuses to bundle those for a browser. The catalogue itself needs
// nothing but zod and the claim grammar, so it gets an entry point that says
// so — the same arrangement `./containment` already has for the hook, and for
// the same reason: a leaf that must load somewhere the barrel cannot.
import { GATE_CATALOGUE, type GateId, type ProjectGateConfig } from '@vorschicht/shared/gates';
import {
  DEPLOY_OUTCOME_LABELS,
  type DeploymentView,
  RELEASE_HISTORY_LIMIT,
  releaseHistoryView,
} from '@vorschicht/shared/inbox';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { navigate, segmentAfter, usePath } from './router.js';

/**
 * The projects page and its gate checkboxes (§17.3, §11).
 *
 * One decision runs through the whole file: **the locked six get a checkbox
 * that works.** Greying them out would be the obvious build and it is the wrong
 * one — A62 kept the attempt expressible in the stored document precisely so
 * that §11's "not un-checkable" is a refusal somebody can observe rather than a
 * shape nobody can attack. A disabled checkbox makes the guarantee unprovable,
 * and "nothing to test" and "nothing tested" look identical from outside.
 *
 * So unticking `Tests` here succeeds — in the form. It is submitted, the server
 * refuses it by name, the refusal is rendered, and `audit_log` carries the
 * attempt. That round trip *is* the exit gate.
 *
 * Everything the page renders comes from `GATE_CATALOGUE`: the German label,
 * the description, `locked`, and the sentence naming what an unavailable gate
 * waits for. There is no second list here — a copy would be the one thing that
 * can disagree with §11 about which gates exist.
 */

interface ProjectView {
  id: string;
  slug: string;
  name: string;
  rootPath: string;
  defaultBranch: string;
  selfManaged: boolean;
  readOnly: boolean;
  active: boolean;
  gateConfig: ProjectGateConfig;
  resolvedGateIds: string[];
  /**
   * §12's release history, **unknown until it has been parsed**.
   *
   * Typed as `unknown` on purpose: everything else on this interface is a cast
   * that has been standing since Phase 3, and a cast is an assertion nobody
   * checks — which is exactly how an inbox once rendered its own envelope as a
   * card (A81). The one field arriving with this change is parsed through the
   * schema the server is typed from, and a violation becomes a German sentence
   * on the page instead of `undefined` in the DOM.
   */
  releases: unknown;
  /** `unwired` = this server has no deploy records, so the list means nothing. */
  releaseSource?: 'records' | 'unwired';
}

/** What the release table shows, or why it shows nothing. */
export type ReleaseHistory =
  | { kind: 'releases'; releases: DeploymentView[] }
  | { kind: 'unwired' }
  | { kind: 'invalid'; problem: string };

/**
 * Read §12's release history off a project payload.
 *
 * Three answers rather than an array, because the three are different things a
 * reader has to be able to tell apart: releases, a server that cannot see any
 * (`unwired`), and a payload that did not match the contract. Collapsing the
 * last two into an empty list would put "noch nichts ausgerollt" over a table
 * that was never filled — a page reporting health it did not check.
 */
export function readReleaseHistory(project: {
  releases: unknown;
  releaseSource?: 'records' | 'unwired';
}): ReleaseHistory {
  if (project.releaseSource === 'unwired') return { kind: 'unwired' };
  const parsed = releaseHistoryView.safeParse(project.releases ?? []);
  if (!parsed.success) {
    return {
      kind: 'invalid',
      problem: parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'releases'}: ${issue.message}`)
        .join('; '),
    };
  }
  return { kind: 'releases', releases: parsed.data };
}

/** German, and never rounded to "0 s" for something that took 400 ms. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return 'läuft noch';
  if (ms < 1_000) return `${ms} ms`;
  const seconds = ms / 1_000;
  if (seconds < 90) return `${seconds.toFixed(1).replace('.', ',')} s`;
  return `${Math.round(seconds / 60)} min`;
}

/**
 * One release row as a sentence (§12: "deploys, durations, rollbacks").
 *
 * A rollback names **where it went**, because that is the row somebody opens
 * this page to find: after an alert, the question is what is serving now, and a
 * deployment id does not answer it. When the destination is older than the page
 * window, the sentence says so rather than showing an id as if it were one.
 */
export function releaseSummary(release: DeploymentView): string {
  const outcome = release.outcome ? DEPLOY_OUTCOME_LABELS[release.outcome] : 'unfertig';
  const step = release.outcome ? '' : ` (zuletzt: ${release.lastStep ?? 'nichts protokolliert'})`;
  if (release.outcome !== 'rolled_back' || !release.rolledBackTo) return `${outcome}${step}`;
  const target = release.rolledBackTo;
  const named = target.sha
    ? `${shortSha(target.sha)}${target.artifact ? ` (${target.artifact})` : ''}`
    : `ein älteres Release außerhalb der letzten ${RELEASE_HISTORY_LIMIT} (${target.deploymentId})`;
  return `${outcome} auf ${named}`;
}

export function shortSha(sha: string): string {
  return sha.length > 10 ? sha.slice(0, 10) : sha;
}

/** The form's working copy — strings, because that is what inputs hold. */
interface FormState {
  gates: Partial<Record<GateId, boolean>>;
  commands: Partial<Record<GateId, string>>;
  tools: string;
  migrationPaths: string;
}

function toForm(config: ProjectGateConfig): FormState {
  return {
    gates: { ...config.gates },
    commands: { ...config.commands },
    tools: config.tools.join('\n'),
    migrationPaths: config.migrationPaths.join('\n'),
  };
}

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * The document to submit — only what carries information.
 *
 * Three of the four combinations are silence. An unticked *optional* gate is
 * absent, because absence already means "not ticked". A ticked *locked* gate is
 * absent too, because `resolveGates` adds the locked six from the catalogue
 * whatever the document says, so writing them down states nothing and only
 * makes a configuration saved here differ from the identical one saved by
 * onboarding — a diff that reads as a change and is not one.
 *
 * The fourth is the whole reason this function exists: an **unticked locked
 * gate travels as an explicit `false`**. That is the attempt §11 has to refuse,
 * and dropping it here would make the form swallow it quietly — the page would
 * look like it had saved, the gate would still run, and `audit_log` would hold
 * nothing. Worse than either outcome the exit gate contemplates, and invisible.
 */
export function toDocument(form: FormState): unknown {
  const gates: Record<string, boolean> = {};
  for (const gate of GATE_CATALOGUE) {
    const ticked = form.gates[gate.id] ?? gate.locked;
    if (gate.locked) {
      if (!ticked) gates[gate.id] = false;
    } else if (ticked) {
      gates[gate.id] = true;
    }
  }
  const commands: Record<string, string> = {};
  for (const [id, spec] of Object.entries(form.commands)) {
    if (spec && spec.trim() !== '') commands[id] = spec.trim();
  }
  return {
    gates,
    commands,
    tools: lines(form.tools),
    migrationPaths: lines(form.migrationPaths),
  };
}

export function Projekte() {
  const path = usePath();
  const slug = segmentAfter(path, '/projekte');
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/projekte', { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Serverfehler ${response.status}`);
      const body = (await response.json()) as { projekte: ProjectView[] };
      setProjects(body.projekte);
      setLoadError(null);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadError) {
    return (
      <section className="karte">
        <h2>Projekte</h2>
        <p data-testid="projekte-fehler" role="alert" className="streifen" data-ton="fehler">
          Projekte nicht ladbar: {loadError}
        </p>
      </section>
    );
  }

  if (!projects) {
    return (
      <section className="karte">
        <h2>Projekte</h2>
        <p className="leise">Wird geladen…</p>
      </section>
    );
  }

  const selected = slug ? projects.find((project) => project.slug === slug) : undefined;

  if (slug && !selected) {
    return (
      <section className="karte">
        <h2>Projekte</h2>
        <p data-testid="projekt-unbekannt" role="alert" className="streifen" data-ton="fehler">
          Kein Projekt mit der Kennung „{slug}".
        </p>
        <p className="knopfreihe">
          <button type="button" className="knopf" onClick={() => navigate('/projekte')}>
            Zur Übersicht
          </button>
        </p>
      </section>
    );
  }

  if (selected) {
    return <ProjektEinstellungen project={selected} onSaved={load} />;
  }

  return (
    <section className="karte">
      <h2>Projekte</h2>
      {projects.length === 0 ? (
        <p data-testid="keine-projekte" className="leerstand">
          Noch kein Projekt aufgenommen. Die Aufnahme läuft über den Trockenlauf nach §20.
        </p>
      ) : (
        <ul data-testid="projektliste" className="liste">
          {projects.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                data-testid={`projekt-${project.slug}`}
                className="knopf"
                data-inhalt="daten"
                onClick={() => navigate(`/projekte/${project.slug}`)}
              >
                {project.name}
              </button>{' '}
              · {project.resolvedGateIds.length} Gates
              {project.readOnly && ' · nur Analyse (A41)'}
              {project.selfManaged && ' · selbstverwaltet'}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProjektEinstellungen({
  project,
  onSaved,
}: {
  project: ProjectView;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState<FormState>(() => toForm(project.gateConfig));
  const [errors, setErrors] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A reload after a successful save brings a new object for the same project;
  // without this the form would keep showing the pre-save working copy and a
  // second submission would re-send it.
  const configKey = useMemo(() => JSON.stringify(project.gateConfig), [project.gateConfig]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the serialised config, which is what changes
  useEffect(() => setForm(toForm(project.gateConfig)), [configKey]);

  const ticked = (id: GateId, locked: boolean) => form.gates[id] ?? locked;

  async function submit() {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch(`/api/projekte/${project.id}/gates`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toDocument(form)),
      });
      if (response.status === 422) {
        const body = (await response.json()) as { errors: string[] };
        setErrors(body.errors);
        setNote(null);
        return;
      }
      if (!response.ok) {
        setErrors([`Serverfehler ${response.status}`]);
        return;
      }
      setErrors([]);
      setNote('Gespeichert.');
      await onSaved();
    } catch (cause) {
      setErrors([cause instanceof Error ? cause.message : String(cause)]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="karte">
      {/* Ein Projektname ist Inhalt — „acme2026" trägt vier Ziffern. */}
      <h2 data-testid="projekt-name" data-inhalt="daten">
        {project.name}
      </h2>
      <p className="knopfreihe">
        <button type="button" className="knopf" onClick={() => navigate('/projekte')}>
          Zurück zur Übersicht
        </button>
      </p>
      <p data-testid="projekt-pfad" className="leise">
        <code>{project.rootPath}</code> · Integrationszweig <code>{project.defaultBranch}</code>
        {project.readOnly && ' · dieses Projekt wird nur analysiert, nie beschrieben (A41)'}
        {project.selfManaged &&
          ' · Vorschicht selbst — ein Merge ist noch kein Rollout, jeder Selbst-Deploy braucht deine Freigabe (A12)'}
      </p>

      <h3>Prüfungen vor dem Zusammenführen (§11)</h3>
      <p>
        Die sechs gesperrten Gates gelten für jedes Projekt und lassen sich nicht abwählen. Das
        Häkchen lässt sich trotzdem entfernen — der Versuch wird vom Server abgelehnt und
        protokolliert, statt hier stillschweigend zu verschwinden.
      </p>

      {errors.length > 0 && (
        <ul data-testid="gate-fehler" role="alert" className="streifen" data-ton="fehler">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      {note && (
        <p data-testid="gate-gespeichert" className="streifen" data-ton="hinweis">
          {note}
        </p>
      )}

      {/*
        Jedes Gate eine Wahlzeile — angehakt liegt sie auf Papier, sonst in der
        Rille. Bewusst **kein** ausgegrautes Häkchen bei den gesperrten sechs:
        A62 hält den Versuch ausdrücklich offen, damit §11s „nicht abwählbar"
        eine beobachtbare Ablehnung ist statt einer Form, die niemand angreifen
        kann. Ein `disabled` nähme genau diesen Nachweis eine Ebene höher weg.
      */}
      <ul data-testid="gate-liste" className="stapel">
        {GATE_CATALOGUE.map((gate) => (
          <li
            key={gate.id}
            className="wahl"
            data-gewaehlt={ticked(gate.id, gate.locked) ? '' : undefined}
          >
            <label htmlFor={`gate-${gate.id}`}>
              <input
                id={`gate-${gate.id}`}
                data-testid={`gate-${gate.id}`}
                type="checkbox"
                checked={ticked(gate.id, gate.locked)}
                onChange={(event) =>
                  setForm((previous) => ({
                    ...previous,
                    gates: { ...previous.gates, [gate.id]: event.target.checked },
                  }))
                }
              />{' '}
              {gate.label}
              {gate.locked && ' (gesperrt, §11)'}
            </label>
            <p className="leise">{gate.description}</p>
            {gate.availableFrom && (
              <p data-testid={`gate-${gate.id}-noch-nicht`} className="etikett" data-ton="schlecht">
                Noch nicht verfügbar: {gate.availableFrom}
              </p>
            )}
            {gate.needsCommand && (
              <p className="feld">
                <label htmlFor={`befehl-${gate.id}`}>Befehl</label>
                <input
                  id={`befehl-${gate.id}`}
                  data-testid={`befehl-${gate.id}`}
                  value={form.commands[gate.id] ?? ''}
                  placeholder="z. B. pnpm test"
                  onChange={(event) =>
                    setForm((previous) => ({
                      ...previous,
                      commands: { ...previous.commands, [gate.id]: event.target.value },
                    }))
                  }
                />
              </p>
            )}
          </li>
        ))}
      </ul>

      <h3>Weiteres</h3>
      <p className="feld">
        <label htmlFor="tools">Erlaubte Bash-Bereiche für Coder-Sitzungen (eine pro Zeile)</label>
        <textarea
          id="tools"
          data-testid="tools"
          rows={3}
          value={form.tools}
          onChange={(event) => setForm((previous) => ({ ...previous, tools: event.target.value }))}
        />
      </p>
      <p className="feld">
        <label htmlFor="migrationspfade">
          Pfade, die als Datenbankmigration gelten (eine pro Zeile; leer = die breiten Vorgaben)
        </label>
        <textarea
          id="migrationspfade"
          data-testid="migrationspfade"
          rows={3}
          value={form.migrationPaths}
          onChange={(event) =>
            setForm((previous) => ({ ...previous, migrationPaths: event.target.value }))
          }
        />
      </p>

      <p className="knopfreihe">
        <button
          type="button"
          data-testid="gates-speichern"
          className="knopf"
          data-ton="haupt"
          onClick={submit}
          disabled={busy}
        >
          Speichern
        </button>
      </p>

      <h3>Läuft derzeit</h3>
      <p data-testid="gates-aktiv">
        {project.resolvedGateIds
          .map((id) => GATE_CATALOGUE.find((gate) => gate.id === id)?.label ?? id)
          .join(' · ')}
      </p>

      <Releases project={project} />
    </section>
  );
}

/** §12: "Release history (deploys, durations, rollbacks) visible per project." */
function Releases({ project }: { project: ProjectView }) {
  const history = readReleaseHistory(project);

  if (history.kind === 'unwired') {
    return (
      <section className="karte">
        <h3>Releases (§12)</h3>
        <p data-testid="releases-unverdrahtet" className="leerstand">
          Dieser Server liest keine Deployments — die Liste wäre leer, ohne etwas über das Projekt
          auszusagen.
        </p>
      </section>
    );
  }

  if (history.kind === 'invalid') {
    return (
      <section className="karte">
        <h3>Releases (§12)</h3>
        <p data-testid="releases-fehler" role="alert" className="streifen" data-ton="fehler">
          Die Release-Historie passt nicht zum vereinbarten Format: {history.problem}
        </p>
      </section>
    );
  }

  if (history.releases.length === 0) {
    return (
      <section className="karte">
        <h3>Releases (§12)</h3>
        <p data-testid="keine-releases" className="leerstand">
          Für dieses Projekt wurde noch nichts ausgerollt.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h3>Releases (§12)</h3>
      <p>Die letzten {RELEASE_HISTORY_LIMIT} Rollouts, neueste zuerst.</p>
      {/* Sechs Spalten rollen in ihrem eigenen Feld statt in der Seite. */}
      <div className="tabellenfeld">
        <table data-testid="releaseliste">
          <thead>
            <tr>
              <th scope="col">Commit</th>
              <th scope="col">Methode</th>
              <th scope="col">Artefakt</th>
              <th scope="col">Ergebnis</th>
              <th scope="col">Dauer</th>
              <th scope="col">Begonnen</th>
            </tr>
          </thead>
          <tbody>
            {history.releases.map((release) => (
              <tr key={release.id} data-testid={`release-${release.id}`}>
                <td>
                  <code>{shortSha(release.sha)}</code>
                </td>
                <td>{release.method}</td>
                <td>{release.artifact ?? '—'}</td>
                <td data-testid={`release-${release.id}-ergebnis`}>
                  {releaseSummary(release)}
                  {release.problem && (
                    <>
                      <br />
                      <small>{release.problem}</small>
                    </>
                  )}
                </td>
                <td>{formatDuration(release.durationMs)}</td>
                <td>{new Date(release.startedAt).toLocaleString('de-AT')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
