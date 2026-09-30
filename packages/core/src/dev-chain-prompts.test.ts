/**
 * What the three roles are actually told (§8.1).
 *
 * These assertions look like string matching and are not: each one is a fact
 * that has to cross a session boundary. §8.1 chains three sessions that share no
 * context, so anything a later role needs is carried by the prompt or is lost —
 * and "lost" here means a Coder that invents a claim set or a Reviewer that
 * diffs against the wrong commit.
 */
import { describe, expect, it } from 'vitest';
import {
  type ChainPromptContext,
  coderPrompt,
  debuggerPrompt,
  mandateBlock,
  plannerPrompt,
  reviewerPrompt,
} from './dev-chain-prompts.js';
import type { ProjectRecord } from './project-service.js';
import type { TaskRecord } from './task-service.js';

const project: ProjectRecord = {
  id: 'p1',
  slug: 'sandkasten',
  name: 'Sandkasten',
  rootPath: '/opt/sandkasten',
  repoUrl: null,
  gitAccessRef: null,
  gateConfig: {},
  deployConfig: {},
  claimGranularity: 'file',
  selfManaged: false,
  readOnly: false,
  defaultBranch: 'main',
  active: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const task: TaskRecord = {
  id: 't1',
  projectId: 'p1',
  state: 'planning',
  priority: 'P1',
  resumeState: null,
  version: 3,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  title: 'Begrüßung erweitern',
  description: 'Die Begrüßung soll eine Anrede tragen.',
  acceptanceCriteria: ['greet() liefert die Anrede', 'Ein Test deckt sie ab'],
  department: 'Entwicklung',
  type: 'feature',
  goalId: null,
  parentTaskId: null,
  worktreePath: '/srv/vorschicht/worktrees/sandkasten/task-t1',
  branch: 'vorschicht/task-t1',
  retryCount: 0,
  parkCount: 0,
  interruptCount: 0,
};

const context: ChainPromptContext = {
  task,
  project,
  worktree: {
    path: '/srv/vorschicht/worktrees/sandkasten/task-t1',
    branch: 'vorschicht/task-t1',
    baseBranch: 'main',
    baseSha: 'abcdef0123456789abcdef0123456789abcdef01',
  },
};

const plan = {
  status: 'done' as const,
  summary: 'Plan.',
  artifacts: [],
  followups: [],
  claimSet: ['src/**'],
  plan: ['Anrede ergänzen', 'Test schreiben'],
  testPlan: ['npm test'],
  risks: ['Die Signatur ändert sich'],
};

describe('mandateBlock', () => {
  it('trägt Titel, Beschreibung und Akzeptanzkriterien', () => {
    const text = mandateBlock(context);
    expect(text).toContain('Begrüßung erweitern');
    expect(text).toContain('Die Begrüßung soll eine Anrede tragen.');
    expect(text).toContain('1. greet() liefert die Anrede');
    expect(text).toContain('2. Ein Test deckt sie ab');
  });

  it('nennt Worktree, Branch und Basis-Commit', () => {
    const text = mandateBlock(context);
    expect(text).toContain('/srv/vorschicht/worktrees/sandkasten/task-t1');
    expect(text).toContain('vorschicht/task-t1');
    expect(text).toContain('abcdef012345');
  });

  it('sagt es laut, wenn der Auftrag unvollständig ist, statt ihn zu erfinden', () => {
    const text = mandateBlock({
      ...context,
      task: { ...task, description: null, acceptanceCriteria: [] },
    });
    expect(text).toContain('No description was recorded');
    expect(text).toContain('planning gap');
  });

  it('behandelt eine leere Beschreibung wie eine fehlende', () => {
    const text = mandateBlock({ ...context, task: { ...task, description: '   ' } });
    expect(text).toContain('No description was recorded');
  });
});

describe('plannerPrompt', () => {
  it('verlangt Lektüre vor dem Plan und benennt den Adressaten', () => {
    const text = plannerPrompt(context);
    expect(text).toContain('Read the repository');
    expect(text).toContain('will not see this session');
  });
});

describe('coderPrompt', () => {
  it('trägt Plan, Testplan, Risiken und die belegten Pfade', () => {
    const text = coderPrompt({ ...context, plan, claims: ['src/**', 'greet.test.js'] });
    expect(text).toContain('1. Anrede ergänzen');
    expect(text).toContain('- npm test');
    expect(text).toContain('- Die Signatur ändert sich');
    expect(text).toContain('- src/**');
    expect(text).toContain('- greet.test.js');
  });

  it('nennt in der ersten Runde keine Befunde', () => {
    const text = coderPrompt({ ...context, plan, claims: ['src/**'] });
    expect(text).not.toContain('Review round');
  });

  it('reicht Befunde einer Review-Runde weiter, mit Datei und Zeile', () => {
    const text = coderPrompt({
      ...context,
      plan,
      claims: ['src/**'],
      feedback: {
        round: 1,
        verdict: 'changes_requested',
        summary: 'Der Test prüft nichts.',
        findings: [
          { file: 'greet.test.js', line: 7, severity: 'blocker', summary: 'Tautologischer Test' },
        ],
        outOfClaims: [],
      },
    });
    expect(text).toContain('Review round 1');
    expect(text).toContain('`greet.test.js:7`');
    expect(text).toContain('Tautologischer Test');
    expect(text).not.toContain('outside your claim set');
  });

  it('trennt maschinell festgestellte Claim-Verstöße von Review-Meinungen', () => {
    const text = coderPrompt({
      ...context,
      plan,
      claims: ['src/**'],
      feedback: {
        round: 2,
        verdict: 'changes_requested',
        summary: '',
        findings: [],
        outOfClaims: ['README.md'],
      },
    });
    expect(text).toContain('outside your claim set');
    expect(text).toContain('- README.md');
    expect(text).toContain('not an opinion');
    // Ein Review ohne benannte Datei bleibt sichtbar statt zu verschwinden.
    expect(text).toContain('without naming a file');
  });
});

describe('reviewerPrompt', () => {
  it('nennt den Basis-Commit als Vergleichspunkt, nicht HEAD', () => {
    const text = reviewerPrompt({
      ...context,
      plan,
      claims: ['src/**'],
      coderSummary: 'Fertig.',
      round: 1,
    });
    expect(text).toContain('git diff abcdef0123456789abcdef0123456789abcdef01');
    expect(text).toContain('not against HEAD');
  });

  it('kennzeichnet die Aussage des Coders als zu prüfende Behauptung', () => {
    const text = reviewerPrompt({
      ...context,
      plan,
      claims: ['src/**'],
      coderSummary: 'Alles grün.',
      round: 1,
    });
    expect(text).toContain('Alles grün.');
    expect(text).toContain('after** you have read the diff');
    expect(text).toContain('a claim you are checking');
  });

  it('weist ab Runde 2 auf die früheren Befunde hin', () => {
    const first = reviewerPrompt({
      ...context,
      plan,
      claims: ['src/**'],
      coderSummary: 'x',
      round: 1,
    });
    const second = reviewerPrompt({
      ...context,
      plan,
      claims: ['src/**'],
      coderSummary: 'x',
      round: 2,
    });
    expect(first).not.toContain('review round 2');
    expect(second).toContain('This is review round 2');
  });

  it('verschweigt nicht, dass der Coder nichts geschrieben hat', () => {
    const text = reviewerPrompt({
      ...context,
      plan,
      claims: ['src/**'],
      coderSummary: '   ',
      round: 1,
    });
    expect(text).toContain('recorded no summary');
  });
});

describe('debuggerPrompt', () => {
  it('zitiert den Fehler und nennt der Betreiber als Leser des Ergebnisses', () => {
    const text = debuggerPrompt({
      ...context,
      problem: 'Der Bau schlägt fehl.\nZweite Zeile.',
      retryCount: 2,
    });
    expect(text).toContain('failed 2 time(s)');
    expect(text).toContain('> Der Bau schlägt fehl.');
    // Mehrzeilige Fehler bleiben als Zitat erkennbar.
    expect(text).toContain('> Zweite Zeile.');
    expect(text).toContain('the operator reads');
    expect(text).toContain('You fix nothing');
  });
});

/**
 * §11's pipeline, at the boundary where it either works or silently does not.
 *
 * The findings themselves are proven in `findings.test.ts` and the record in
 * `findings.itest.ts`. What is asserted here is the one thing neither of those
 * can see: that the briefing is *in the prompt* of each role that needs it. A
 * pipeline whose middle arrow is a section nobody appended looks exactly like a
 * pipeline that works, from every other vantage point in this repository.
 */
describe('offene Befunde im Auftrag (§11, Phase 3 Schritt 4)', () => {
  const open = [
    {
      id: 'deadbeef-1111-2222-3333-444455556666',
      gateId: 'test' as const,
      detail: 'Die Testsuite ist rot.',
      output: 'not ok 3 - greets a name',
    },
  ];
  const briefed: ChainPromptContext = { ...context, openFindings: open };

  it('erreicht den Planner — sonst plant er denselben Plan noch einmal', () => {
    const text = plannerPrompt(briefed);
    expect(text).toContain('Gates that blocked this change');
    expect(text).toContain('deadbeef');
    expect(text).toContain('not ok 3');
    // And the consequence for *his* job specifically: the claim set has to
    // cover the fix, or the next Coder is refused before it writes.
    expect(text).toContain('claim set has to cover');
  });

  it('erreicht den Coder mit der wörtlichen Ausgabe', () => {
    const text = coderPrompt({ ...briefed, plan, claims: ['src/**'] });
    expect(text).toContain('Gates that blocked this change');
    expect(text).toContain('not ok 3 - greets a name');
  });

  it('erreicht den Reviewer, samt der Frage, die nur ein Leser beantworten kann', () => {
    const text = reviewerPrompt({
      ...briefed,
      plan,
      claims: ['src/**'],
      coderSummary: 'Behoben.',
      round: 1,
    });
    expect(text).toContain('Gates that blocked this change');
    expect(text).toContain('not merely made to pass');
    expect(text).toContain('disabled test');
  });

  it('fehlt beim ersten Anlauf vollständig — in allen drei Rollen', () => {
    // The negative half matters as much: a heading that is always present makes
    // "this task has failed before" unreadable, and every first attempt would
    // be told to fix nothing in particular.
    for (const text of [
      plannerPrompt(context),
      coderPrompt({ ...context, plan, claims: ['src/**'] }),
      reviewerPrompt({ ...context, plan, claims: ['src/**'], coderSummary: 'x', round: 1 }),
    ]) {
      expect(text).not.toContain('Gates that blocked this change');
    }
    expect(plannerPrompt(context)).not.toContain('claim set has to cover');
    expect(
      reviewerPrompt({ ...context, plan, claims: ['src/**'], coderSummary: 'x', round: 1 }),
    ).not.toContain('not merely made to pass');
  });
});
