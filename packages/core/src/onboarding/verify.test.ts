/**
 * The half of an onboarding proposal that is checked rather than believed (§20).
 *
 * Everything here is pure: a fixture survey in, a verdict out. That is the point
 * of splitting the survey from the verification — the file reading happened
 * once, in a component with its own integration test, and the rules that decide
 * whether a proposal may be stored are testable without a repository, a database
 * or a model.
 *
 * The assertion that carries the most weight is the one about an **undeclared**
 * script. A gate whose command names a script the project does not have never
 * blocks and never goes red: the binary starts, the script is missing, and A25
 * reads "nothing ran" as an infrastructure failure to retry (A55.3). The only
 * visible consequence is an Ops alert weeks later that names a machine problem.
 * If this file's `undeclared` case ever stops refusing, that class is back.
 */
import type { OnboardingResult } from '@vorschicht/shared';
import { describe, expect, it } from 'vitest';
import type { RepositorySurvey } from './survey.js';
import { declaredMakeTargets, declaredScripts, verifyCommand, verifyProposal } from './verify.js';

const PACKAGE_JSON = JSON.stringify({
  name: 'fixture',
  scripts: { test: 'vitest run', lint: 'biome check .', 'gate:build': 'tsc --build' },
});

const MAKEFILE = ['check:', '\techo ok', 'build: check', '\techo built', '.PHONY: check'].join(
  '\n',
);

function survey(overrides: Partial<RepositorySurvey> = {}): RepositorySurvey {
  return {
    rootPath: '/opt/fixture',
    git: {
      isRepository: true,
      defaultBranch: 'main',
      checkedOutBranch: 'main',
      defaultBranchSource: 'git symbolic-ref --short refs/remotes/origin/HEAD',
      remoteUrl: 'git@example.invalid:fixture.git',
      headSha: 'abc123',
      commitCount: 12,
      lastCommit: 'abc123 2026-08-01 etwas',
      branches: ['main', 'dev'],
    },
    files: ['package.json', 'Makefile', 'src/index.ts', 'infra/scripts/check.sh'],
    packages: [
      { dir: '.', name: 'fixture', scripts: ['test', 'lint', 'gate:build'] },
      { dir: 'apps/web', name: '@fixture/web', scripts: ['build', 'preview'] },
    ],
    inventory: {
      fileCount: 4,
      extensions: [{ extension: '.ts', count: 1 }],
      topLevel: ['package.json', 'Makefile', 'src/', 'infra/'],
      personalDataHints: [],
      migrationCandidates: [],
      testCandidates: [],
    },
    manifests: [
      { path: 'package.json', content: PACKAGE_JSON },
      { path: 'Makefile', content: MAKEFILE },
    ],
    ci: [],
    deploy: [],
    conventions: [],
    sources: ['git ls-files --cached --others --exclude-standard'],
    gaps: [],
    ...overrides,
  };
}

function proposal(overrides: Partial<OnboardingResult> = {}): OnboardingResult {
  return {
    status: 'done',
    summary: 'Vorschlag.',
    artifacts: [],
    followups: [],
    stack: 'TypeScript',
    defaultBranch: 'main',
    gates: [
      { id: 'test', enabled: true, command: 'pnpm run test', rationale: 'deklariert' },
      { id: 'lint', enabled: true, command: 'pnpm lint', rationale: 'deklariert' },
      { id: 'build', enabled: true, command: 'pnpm run gate:build', rationale: 'deklariert' },
      { id: 'typecheck', enabled: true, command: 'pnpm exec tsc --noEmit', rationale: 'Programm' },
    ],
    claimGranularity: 'file',
    claimRationale: 'Flache Anwendung.',
    migrationPaths: [],
    tools: ['Bash(pnpm:*)'],
    deploy: { method: 'none', rationale: 'Bibliothek, kein Rollout.' },
    personalData: { present: false, evidence: [] },
    departments: ['Entwicklung'],
    risks: [],
    ...overrides,
  };
}

const detailsOf = (result: ReturnType<typeof verifyProposal>): string => result.errors.join(' | ');

describe('verifyCommand — was das Projekt selbst deklariert', () => {
  const context = () => ({
    scripts: declaredScripts(survey()),
    makeTargets: declaredMakeTargets(survey()),
    survey: survey(),
  });

  it('belegt ein Skript aus der package.json', () => {
    expect(verifyCommand('test', 'pnpm run test', context()).status).toBe('declared');
    // Without `run`, which is how everybody actually writes it.
    expect(verifyCommand('lint', 'pnpm lint', context()).status).toBe('declared');
    // `pnpm -r`, where the script exists in the root as well.
    expect(verifyCommand('test', 'pnpm -r test', context()).status).toBe('declared');
  });

  it('findet ein Skript im gefilterten Paket, nicht nur im Wurzelmanifest (A72)', () => {
    // The defect this case exists for was found by running the checker against a
    // real monorepo: `pnpm --filter web build` was refused because the *root*
    // manifest has no `build`, while `apps/web` declares one. A correct command
    // refused is the expensive direction — it discards a whole proposal.
    const verdict = verifyCommand('build', 'pnpm --filter web build', context());
    expect(verdict.status).toBe('declared');
    expect(verdict.detail).toContain('apps/web/package.json');
    // Also by package name and with the `=` form.
    expect(verifyCommand('build', 'pnpm --filter @fixture/web build', context()).status).toBe(
      'declared',
    );
    expect(verifyCommand('build', 'pnpm --filter=web preview', context()).status).toBe('declared');
    expect(verifyCommand('build', 'pnpm -F web build', context()).status).toBe('declared');
  });

  it('verweigert auch im gefilterten Paket ein Skript, das dort fehlt', () => {
    // The widening must not soften the check: `build` exists in `apps/web` and
    // not in the root, so asking the root for it is still a refusal.
    const verdict = verifyCommand('build', 'pnpm --filter . build', context());
    expect(verdict.status).toBe('undeclared');
    expect(verdict.detail).toContain('gate:build');
  });

  it('nennt ein unbekanntes Filterziel nicht prüfbar statt falsch', () => {
    const verdict = verifyCommand('build', 'pnpm --filter api build', context());
    expect(verdict.status).toBe('unverifiable');
    expect(verdict.detail).toContain('--filter api');
  });

  it('versteht auch npms Auswahl-Schalter, nicht nur pnpms (A80)', () => {
    // Found by the first live run against the pilot project: `npm --prefix web run build`
    // fell through every branch and came back "das Projekt hat keine lesbare
    // package.json mit Skripten" — about a project whose `web/package.json` the
    // very same survey had read and listed in its evidence section.
    for (const command of [
      'npm --prefix apps/web run build',
      'npm -C apps/web run build',
      'npm --workspace @fixture/web run build',
      'npm -w web run build',
      'npm --prefix=apps/web run build',
    ]) {
      const verdict = verifyCommand('build', command, context());
      expect(verdict.status, command).toBe('declared');
      expect(verdict.detail, command).toContain('apps/web/package.json');
    }
  });

  it('nennt den Schalter, den der Befehl wirklich benutzt hat', () => {
    // Answering `--prefix api` with a sentence about `--filter` would be a
    // second false statement in the branch that exists to avoid the first.
    const verdict = verifyCommand('build', 'npm --prefix api run build', context());
    expect(verdict.status).toBe('unverifiable');
    expect(verdict.detail).toContain('--prefix api');
    expect(verdict.detail).not.toContain('--filter');
  });

  it('sagt bei einem Manifest ohne Wurzel die Wahrheit statt „es gibt keins"', () => {
    // the pilot project exactly: one package.json, in a subdirectory, and a command that
    // selects nothing. The old answer claimed no manifest existed.
    const nurUnterordner = survey({
      packages: [{ dir: 'web', name: 'example-web', scripts: ['build', 'test'] }],
      manifests: [],
    });
    const verdict = verifyCommand('build', 'npm run build', {
      scripts: null,
      makeTargets: null,
      survey: nurUnterordner,
    });
    expect(verdict.status).toBe('unverifiable');
    expect(verdict.detail).toContain('`web/`');
    expect(verdict.detail).toContain('Wurzelverzeichnis');
    // The sentence that was wrong must not come back.
    expect(verdict.detail).not.toContain('keine lesbare `package.json`');
  });

  it('akzeptiert bei -r ein Skript aus irgendeinem Paket des Workspace', () => {
    // `pnpm -r preview` runs wherever `preview` exists; the root need not have it.
    const verdict = verifyCommand('e2e', 'pnpm -r preview', context());
    expect(verdict.status).toBe('declared');
    expect(verdict.detail).toContain('Pakete dieses Workspace');
    expect(verifyCommand('e2e', 'pnpm -r gibtsnicht', context()).status).toBe('undeclared');
  });

  it('prüft das Skript hinter einem Interpreter wie einen Pfad', () => {
    expect(verifyCommand('test', 'node infra/scripts/check.sh', context()).status).toBe('declared');
    const missing = verifyCommand('test', 'node scripts/pruef.mjs', context());
    expect(missing.status).toBe('undeclared');
    expect(missing.detail).toContain('scripts/pruef.mjs');
    // A bare interpreter with nothing file-shaped after it stays unverifiable.
    expect(verifyCommand('test', 'node --test', context()).status).toBe('unverifiable');
  });

  it('verweigert ein Skript, das es nicht gibt — und nennt die vorhandenen', () => {
    const verdict = verifyCommand('test', 'pnpm run tests', context());
    expect(verdict.status).toBe('undeclared');
    expect(verdict.detail).toContain('gate:build');
    expect(verdict.detail).toContain('lint');
    // The sentence has to say *why* this is refused rather than noted: a gate on
    // a missing script is silently permanent, not loudly broken.
    expect(verdict.detail).toMatch(/blockiert nie und wird nie rot/);
  });

  it('hält einen Programmaufruf für nicht prüfbar, nicht für falsch', () => {
    // `pnpm exec` runs a binary; there is no script to look for, and refusing
    // would refuse a correct command.
    expect(verifyCommand('typecheck', 'pnpm exec tsc --noEmit', context()).status).toBe(
      'unverifiable',
    );
    // A stack this function does not read at all.
    expect(verifyCommand('test', 'cargo test', context()).status).toBe('unverifiable');
  });

  it('prüft make-Ziele gegen das Makefile', () => {
    expect(verifyCommand('test', 'make check', context()).status).toBe('declared');
    const bad = verifyCommand('test', 'make pruefen', context());
    expect(bad.status).toBe('undeclared');
    expect(bad.detail).toContain('check');
    // `.PHONY:` is a directive, not a target somebody can run.
    expect(declaredMakeTargets(survey())?.has('.PHONY')).toBe(true);
  });

  it('prüft einen Pfad gegen die vollständige Dateiliste', () => {
    expect(verifyCommand('test', 'infra/scripts/check.sh', context()).status).toBe('declared');
    expect(verifyCommand('test', './infra/scripts/check.sh', context()).status).toBe('declared');
    const missing = verifyCommand('test', './infra/scripts/nope.sh', context());
    expect(missing.status).toBe('undeclared');
    expect(missing.detail).toMatch(/vom Host abhängt/);
  });

  it('sagt „nicht prüfbar", wenn es gar keine Dateiliste gibt', () => {
    // Not `undeclared`: "I could not look" and "it is not there" are different
    // answers, and only the second may refuse a proposal.
    const blind = survey({ files: [], inventory: { ...survey().inventory, fileCount: 0 } });
    const verdict = verifyCommand('test', './scripts/check.sh', {
      scripts: declaredScripts(blind),
      makeTargets: null,
      survey: blind,
    });
    expect(verdict.status).toBe('unverifiable');
  });

  it('hält eine unlesbare package.json für unbekannt, nicht für leer', () => {
    // The survey records an unparseable manifest as a gap and adds no package
    // entry for it. Treating that as "declares nothing" would turn every
    // proposed command into a refusal.
    const broken = survey({
      packages: [],
      manifests: [{ path: 'package.json', content: '{ "scripts": ' }],
      gaps: ['`package.json` ist kein lesbares JSON; seine Skripte sind unbekannt.'],
    });
    expect(declaredScripts(broken)).toBeNull();
    expect(
      verifyCommand('test', 'pnpm run test', {
        scripts: declaredScripts(broken),
        makeTargets: null,
        survey: broken,
      }).status,
    ).toBe('unverifiable');
  });
});

describe('verifyProposal — was gespeichert werden darf', () => {
  it('übernimmt einen belegten Vorschlag', () => {
    const result = verifyProposal(survey(), proposal());
    expect(result.ok, detailsOf(result)).toBe(true);
    expect(result.config?.commands.test).toBe('pnpm run test');
    expect(result.config?.tools).toEqual(['Bash(pnpm:*)']);
    expect(result.defaultBranch).toBe('main');
  });

  it('verweigert den ganzen Vorschlag wegen eines einzigen erfundenen Befehls', () => {
    const result = verifyProposal(
      survey(),
      proposal({
        gates: [{ id: 'test', enabled: true, command: 'pnpm run tests', rationale: 'x' }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.config).toBeNull();
    expect(detailsOf(result)).toContain('pnpm run tests');
  });

  it('meldet einen erfundenen Befehl genau einmal, nicht zweimal', () => {
    // The command is kept in the document even though it was refused, precisely
    // so §11's validator does not add "kein Befehl hinterlegt" beside "der
    // Befehl existiert nicht" — one problem described as two sends the reader
    // looking for a second one.
    const result = verifyProposal(
      survey(),
      proposal({
        gates: [{ id: 'sast', enabled: true, command: 'pnpm run semgrep', rationale: 'x' }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.filter((line) => line.includes('SAST'))).toHaveLength(1);
  });

  it('nennt gesperrte Gates ohne Befehl als ungeprüft, nicht als abgewählt', () => {
    const result = verifyProposal(
      survey(),
      proposal({
        gates: [{ id: 'test', enabled: true, command: 'pnpm run test', rationale: 'x' }],
      }),
    );
    expect(result.ok, detailsOf(result)).toBe(true);
    expect(result.missingCommands).toEqual(['typecheck', 'lint', 'build']);
    expect(result.notes.join(' ')).toMatch(/nicht abgewählt, sondern ungeprüft/);
  });

  it('lässt §11 den Versuch ablehnen, ein gesperrtes Gate abzuwählen', () => {
    // Written into the document as the `false` it is, so the validator refuses
    // it *by name* — the attempt has to be expressible for the refusal to exist.
    const result = verifyProposal(
      survey(),
      proposal({
        gates: [
          { id: 'test', enabled: false, rationale: 'Das Projekt hat keine Tests.' },
          { id: 'lint', enabled: true, command: 'pnpm lint', rationale: 'x' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(detailsOf(result)).toMatch(/gesperrten Grundgerüst/);
    expect(detailsOf(result)).toContain('Tests');
  });

  /*
   * Bis A115 stand hier das Gegenteil: `legal` war das Beispiel für ein
   * vorgeschlagenes, noch nicht baubares Gate, und der Fall prüfte, dass der
   * Vorschlag verschoben statt verworfen wird. Mit Lena ist der Gegenstand weg
   * — nicht der Mechanismus. Er wird jetzt an drei Stellen gehalten, und das
   * ist Absicht: `gateUnavailableReason` in `gates.test.ts` gegen eine
   * synthetische Definition (das Prädikat), der Deploy-Fall unten (die
   * Verschiebung mitsamt ihrer Darstellung), und dieser hier für die eine
   * Aussage, die nur ein echtes Gate treffen kann — dass Lena wirklich
   * übernommen wird, statt weiter still zu verschwinden.
   */
  it('übernimmt das Rechts-Gate jetzt, statt es zu verschieben', () => {
    const result = verifyProposal(
      survey(),
      proposal({
        gates: [
          ...proposal().gates,
          { id: 'legal', enabled: true, rationale: 'Der Verein verarbeitet Mitgliedsdaten.' },
        ],
      }),
    );
    expect(result.ok, detailsOf(result)).toBe(true);
    expect(result.config?.gates.legal).toBe(true);
    // Und die Verschiebung ist wirklich weg statt bloß leiser: ein Eintrag mit
    // demselben Gegenstand wäre eine Karte, die der Betreiber nach einer Abteilung fragt,
    // die es gibt.
    expect(result.deferred.find((item) => item.subject === 'legal')).toBeUndefined();
  });

  it('speichert „compose", seit die Maschine dafür existiert', () => {
    const result = verifyProposal(
      survey(),
      proposal({
        deploy: {
          method: 'compose',
          rationale: 'docker-compose.yml mit einem Dienst.',
          service: 'web',
        },
      }),
    );
    expect(result.ok, detailsOf(result)).toBe(true);
    expect(result.deployConfig.method).toBe('compose');
    expect(result.deferred.find((item) => item.subject === 'deploy')).toBeUndefined();
  });

  it('verschiebt „static-rsync" — und nennt den Grund, der heute stimmt', () => {
    // Die Maschine gibt es seit Phase 5 (A87/A99); was fehlt, ist der Zielhost,
    // den nur der Betreiber nennen kann. Der alte Satz („entsteht erst in Phase 5") war
    // seit dem 3.8. falsch, und nichts ist daran gescheitert — deshalb wird
    // hier der *Grund* zugesichert und nicht bloß, dass verschoben wurde.
    const result = verifyProposal(
      survey(),
      proposal({
        deploy: {
          method: 'static-rsync',
          rationale: 'Statischer Build, kein Server.',
        },
      }),
    );
    expect(result.ok, detailsOf(result)).toBe(true);
    expect(result.deployConfig.method).toBe('none');
    expect((result.deployConfig.proposed as { method: string }).method).toBe('static-rsync');
    const deferred = result.deferred.find((item) => item.subject === 'deploy');
    expect(deferred?.reason).toContain('Zielhost');
    expect(deferred?.reason).not.toContain('entsteht erst in Phase 5');
    // Die Begründung des Vorschlags überlebt — sonst müsste der Betreiber sie
    // rekonstruieren, wenn er den Host nachträgt.
    expect(deferred?.reason).toContain('Statischer Build');
  });

  it('verweigert einen Werkzeug-Scope mit Komma', () => {
    const result = verifyProposal(survey(), proposal({ tools: ['Bash(pnpm:*),Bash(make:*)'] }));
    expect(result.ok).toBe(false);
    expect(detailsOf(result)).toMatch(/Komma/);
  });

  it('verweigert einen Migrationspfad, den die Anspruchsgrammatik nicht kennt', () => {
    const result = verifyProposal(survey(), proposal({ migrationPaths: ['db/[0-9]*.sql'] }));
    expect(result.ok).toBe(false);
    expect(detailsOf(result)).toMatch(/Migrationspfad/);
  });

  it('lässt der mechanischen Auskunft den Vortritt beim Integrationszweig', () => {
    const result = verifyProposal(survey(), proposal({ defaultBranch: 'dev' }));
    expect(result.defaultBranch).toBe('main');
    expect(result.notes.join(' ')).toMatch(/mechanische Auskunft schlägt die Einschätzung/);
  });

  it('folgt dem Vorschlag, wenn origin/HEAD gar nichts sagt', () => {
    // A41 names a real project that develops on `dev`. Without `origin/HEAD` the
    // checked-out branch is where somebody last stood, not what the project's
    // integration branch is — so the reading of the documentation wins, and the
    // divergence is put in front of the operator either way.
    const loose = survey({
      git: {
        ...survey().git,
        defaultBranch: 'main',
        defaultBranchSource: 'git rev-parse --abbrev-ref HEAD (origin/HEAD ist nicht gesetzt …)',
      },
    });
    const result = verifyProposal(loose, proposal({ defaultBranch: 'dev' }));
    expect(result.defaultBranch).toBe('dev');
    expect(result.notes.join(' ')).toMatch(/Bitte gegenprüfen/);
  });

  it('trägt die Lücken der Erhebung in den Vorschlag hinein', () => {
    const result = verifyProposal(
      survey({ gaps: ['Der Integrationszweig ließ sich nicht bestimmen.'] }),
      proposal(),
    );
    expect(result.notes.join(' ')).toContain('Der Integrationszweig ließ sich nicht bestimmen.');
    // Eine gewöhnliche Lücke bleibt eine Notiz: ein Vorschlag wird dadurch
    // ärmer, nicht falsch.
    expect(result.ok).toBe(true);
  });

  it('verweigert einen Vorschlag ohne lesbares Repository — nicht nur eine Notiz', () => {
    // Der Fall, den der erste echte Lauf des Läufers am 5.9.2026 erzeugt hat:
    // eine Einhängung, die git wegen fremder Dateikennung verweigerte. Die
    // Erhebung war leer, `verifyCommand` antwortete auf **jeden** Befehl
    // „unverifiable" — und der Vorschlag hiess trotzdem übernehmbar, weil seine
    // eigenen Prüfungen bestanden hatten.
    //
    // Ohne git gibt es keine Dateiliste und keinen Integrationszweig. Ein
    // `--apply-lauf` darauf legte ein Projekt mit vier unbelegten Gate-Befehlen
    // an, und §11s gesperrte sechs blockierten es auf ewig.
    const result = verifyProposal(
      survey({
        git: {
          isRepository: false,
          defaultBranch: null,
          checkedOutBranch: null,
          defaultBranchSource: 'nicht bestimmbar',
          remoteUrl: null,
          headSha: null,
          commitCount: null,
          lastCommit: null,
          branches: [],
        },
        gaps: ['Das Verzeichnis ist kein git-Repository.'],
      }),
      proposal(),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('kein lesbares git-Repository');
    // Und die Begründung nennt beides, weil der Leser sonst nur die halbe
    // Konsequenz sieht.
    expect(result.errors.join(' ')).toContain('Dateiliste');
    expect(result.errors.join(' ')).toContain('Integrationszweig');
  });
});
