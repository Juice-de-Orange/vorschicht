/**
 * §14's citation rule as a verdict, and the prompt that produces the input.
 *
 * Everything here is pure: no model, no database, no git. That is the split
 * `migration-review` already draws — the *decision* about what a delivered
 * review means is a function of its result, and the only way to assert §14's
 * threshold without spending subscription budget is to hold that function to
 * the four answers `checkCitation` distinguishes.
 *
 * The gate around it (does a session even start, what does the suite do with an
 * infra report) is in `legal-review.itest.ts`, against a real registry and a
 * real git repository. What no test in either file can settle is whether a real
 * Lena cites what she read — that is `pnpm check:legal-review`, once, with a
 * real session.
 */
import type { CitationSubject, LegalResult } from '@vorschicht/shared';
import { checkCitation } from '@vorschicht/shared';
import { describe, expect, it } from 'vitest';
import { judgeLegalReview } from './gate-suite.js';
import {
  LEGAL_SOURCE_LIST_LIMIT,
  type LegalReviewInput,
  legalReviewPrompt,
  type ResolvedCitation,
} from './legal-review.js';
import type { SourceRecord } from './sources/registry.js';

/** A uuid-shaped id, because the contract asks for one and so does Postgres. */
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * One citation plus what the registry said about it.
 *
 * The `check` is produced by the **real** `checkCitation` rather than written
 * by hand: a hand-written check would let this file agree with itself about
 * what "below the threshold" means while `@vorschicht/shared` meant something
 * else, which is the shape §8.2 exists to find.
 */
function cite(
  sourceId: string,
  claimedLevel: number,
  subject: CitationSubject,
  statement = 'Vereine brauchen für eine Statutenänderung einen Beschluss der Mitgliederversammlung.',
): ResolvedCitation {
  return {
    citation: { sourceId, claimedLevel, statement },
    check: checkCitation(subject),
  };
}

const accepted = (level: 1 | 2 | 3 | 4 | 5): CitationSubject => ({
  found: true,
  state: 'accepted',
  level,
});

function result(partial: Partial<LegalResult> = {}): LegalResult {
  return {
    status: 'done',
    summary: 'Die Statutenänderung braucht einen Beschluss der Mitgliederversammlung.',
    artifacts: [],
    followups: [],
    verdict: 'approve',
    citations: [],
    documents: [],
    findings: [],
    ...partial,
  };
}

describe('judgeLegalReview — §14s Schwelle als Urteil', () => {
  it('lässt eine Aussage durch, die auf einer Quelle ab L4 ruht', () => {
    const outcome = judgeLegalReview(result(), [cite(id(1), 4, accepted(4))]);
    expect(outcome.verdict).toBe('green');
    expect(outcome.detail).toContain('L4');
  });

  /**
   * The gate sentence, in the direction that matters: an opinion resting on
   * community sources does not carry, and the refusal names the rule rather
   * than merely refusing.
   */
  it('blockiert eine Aussage, die nur auf L2 ruht — und sagt „unter L4 (§14)"', () => {
    const outcome = judgeLegalReview(result(), [
      cite(id(1), 2, accepted(2)),
      cite(id(2), 2, accepted(2)),
    ]);
    expect(outcome.verdict).toBe('finding');
    expect(outcome.detail).toContain('unter L4');
    expect(outcome.detail).toContain('§14');
  });

  /**
   * §14's second clause: "anything lower triggers a corroboration pass". A weak
   * source is not forbidden — it is not *load-bearing*. Blocking here would be
   * stricter than the spec in a way that quietly forbids citing a blog at all,
   * and §0.3 licenses no more than refusing to weaken a gate.
   */
  it('lässt eine schwache Quelle mitlaufen, solange eine starke trägt', () => {
    const outcome = judgeLegalReview(result(), [
      cite(id(1), 5, accepted(5)),
      cite(id(2), 2, accepted(2)),
    ]);
    expect(outcome.verdict).toBe('green');
    expect(outcome.detail).toContain('Bestätigungsdurchgang');
  });

  /**
   * The loudest of the four answers, and the reason `checkCitation` keeps them
   * apart. A reference that cannot be followed is a different defect from one
   * that is merely weak: the reader has no way to tell it from a real one.
   */
  it('blockiert eine erfundene Quellenkennung — auch neben einer L5-Quelle', () => {
    const outcome = judgeLegalReview(result(), [
      cite(id(1), 5, accepted(5)),
      cite(id(9), 5, { found: false }),
    ]);
    expect(outcome.verdict).toBe('finding');
    expect(outcome.detail).toContain('erfundene Fundstelle');
    expect(outcome.detail).toContain(id(9));
  });

  it('unterscheidet die erfundene Quelle von der bloß zu schwachen', () => {
    // Both are red, and they must not be red for the same *reason*: the
    // remedies differ — cite something that exists, versus corroborate what you
    // cited. So the fabricated case carries the extra sentence and the weak one
    // does not.
    //
    // Honestly stated, because the first version of this case asserted the
    // converse as well and was wrong: a lone fabricated citation is *also* a
    // review in which nothing carries, so it earns the threshold sentence too.
    // Reporting both is the design (§11 sends the work back once, with
    // everything), and an assertion that denied it would have been a wish
    // rather than a property.
    const fabricated = judgeLegalReview(result(), [cite(id(9), 5, { found: false })]);
    const weak = judgeLegalReview(result(), [cite(id(1), 2, accepted(2))]);
    expect(fabricated.verdict).toBe('finding');
    expect(weak.verdict).toBe('finding');
    expect(fabricated.detail).toContain('erfundene Fundstelle');
    expect(weak.detail).not.toContain('erfundene Fundstelle');
    expect(weak.detail).toContain('unter L4');
    // And the sharper half of the distinction, which the messages alone cannot
    // show: beside a source that does carry, the weak citation is permitted
    // (§14's corroboration pass) and the fabricated one still is not. Both
    // directions are asserted in their own cases above; this pins that they
    // really are two different outcomes and not two wordings of one.
    const weakBeside = judgeLegalReview(result(), [
      cite(id(1), 5, accepted(5)),
      cite(id(2), 2, accepted(2)),
    ]);
    const fabricatedBeside = judgeLegalReview(result(), [
      cite(id(1), 5, accepted(5)),
      cite(id(9), 5, { found: false }),
    ]);
    expect(weakBeside.verdict).toBe('green');
    expect(fabricatedBeside.verdict).toBe('finding');
  });

  it('behandelt eine noch nicht aufgenommene Quelle als nicht tragend, aber nicht als erfunden', () => {
    // The third of `checkCitation`'s answers: the source exists and nobody has
    // granted it a level yet. Citing it is premature rather than invented.
    const outcome = judgeLegalReview(result(), [
      cite(id(1), 5, { found: true, state: 'proposed', level: null }),
    ]);
    expect(outcome.verdict).toBe('finding');
    expect(outcome.detail).not.toContain('erfundene Fundstelle');
    expect(outcome.output).toContain('vorgeschlagen');
  });

  /**
   * A54.2, one department over: the observation is the session's and the fact
   * is the registry's. Overstating is how a community post is made to look
   * decisive in a document the operator acts on; understating is caution.
   */
  it('blockiert eine Zitation, die eine höhere Stufe behauptet als das Register vergibt', () => {
    const outcome = judgeLegalReview(result(), [cite(id(1), 5, accepted(4))]);
    expect(outcome.verdict).toBe('finding');
    expect(outcome.detail).toContain('höhere Vertrauensstufe');
    expect(outcome.detail).toContain('behauptet L5, Register L4');
  });

  it('lässt eine untertriebene Stufe durch', () => {
    const outcome = judgeLegalReview(result(), [cite(id(1), 4, accepted(5))]);
    expect(outcome.verdict).toBe('green');
  });

  it('blockiert bei „changes_requested" und führt die Befunde mit', () => {
    const outcome = judgeLegalReview(
      result({
        verdict: 'changes_requested',
        citations: [{ sourceId: id(1), claimedLevel: 5, statement: 'Art 6 Abs 1 DSGVO' }],
        findings: [
          {
            file: 'src/anmeldung.ts',
            line: 42,
            severity: 'blocker',
            summary: 'Gesundheitsdaten ohne ausdrückliche Einwilligung (Art 9 DSGVO)',
          },
        ],
      }),
      [cite(id(1), 5, accepted(5))],
    );
    expect(outcome.verdict).toBe('finding');
    expect(outcome.detail).toContain('Nachbesserung');
    expect(outcome.output).toContain('src/anmeldung.ts:42');
    expect(outcome.output).toContain('Art 9 DSGVO');
  });

  it('blockiert eine Rechtsaussage ohne jede Quelle und sagt es anders als bei zu schwachen', () => {
    // `citations` is `.default([])` rather than `.min(1)` precisely so this
    // arrives here as a gate finding with a German sentence instead of as a
    // schema failure and a repair round.
    const outcome = judgeLegalReview(result(), []);
    expect(outcome.verdict).toBe('finding');
    expect(outcome.detail).toContain('gar keine Quelle');
  });

  it('meldet jeden Verstoß, nicht nur den ersten', () => {
    // §11 sends the work back, and a reviewer told one defect per round takes a
    // round per defect.
    const outcome = judgeLegalReview(result({ verdict: 'changes_requested' }), [
      cite(id(9), 5, { found: false }),
      cite(id(1), 4, accepted(2)),
    ]);
    expect(outcome.verdict).toBe('finding');
    expect(outcome.detail).toContain('Nachbesserung');
    expect(outcome.detail).toContain('erfundene Fundstelle');
    expect(outcome.detail).toContain('unter L4');
    expect(outcome.detail).toContain('höhere Vertrauensstufe');
  });

  /**
   * §22's Phase 6 gate ends "with citations and trust levels shown in the
   * trace", and the trace is this. Asserted on a **green** review, because a
   * ledger that only appears when something is wrong would leave the sentence
   * unproven in the case the gate sentence describes.
   */
  it('legt bei einer grünen Prüfung jede Zitation mit beiden Stufen in die Spur', () => {
    const outcome = judgeLegalReview(
      result({
        documents: [id(70)],
        citations: [
          { sourceId: id(1), claimedLevel: 5, statement: 'VerG 2002 § 5', locator: '§ 5 Abs 2' },
        ],
      }),
      [cite(id(1), 5, accepted(5), 'VerG 2002 § 5')],
    );
    expect(outcome.verdict).toBe('green');
    expect(outcome.output).toContain(id(1));
    expect(outcome.output).toContain('behauptet L5, Register: L5');
    expect(outcome.output).toContain('VerG 2002 § 5');
    // The Statuten the answer was read from, by id — §13's half of the gate
    // sentence, and the only place it survives into the trace.
    expect(outcome.output).toContain(id(70));
  });
});

describe('legalReviewPrompt', () => {
  const source = (partial: Partial<SourceRecord> = {}): SourceRecord => ({
    id: id(1),
    url: 'https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=20001917',
    documentId: null,
    title: 'Vereinsgesetz 2002 (RIS, geltende Fassung)',
    assessment: null,
    proposedLevel: 5,
    level: 5,
    state: 'accepted',
    stateReason: null,
    levelReason: null,
    proposedAt: new Date('2026-08-01T00:00:00Z'),
    proposedBy: 'research',
    curatedAt: null,
    curatedBy: null,
    score: 5.4,
    ...partial,
  });

  const change: LegalReviewInput = {
    kind: 'change',
    repoPath: '/data/worktrees/verein/task-7',
    taskId: 'aufgabe-7',
    projectId: 'projekt-1',
    baseRef: 'main',
    changedFiles: ['src/anmeldung.ts', 'docs/datenschutz.md'],
    readOnlyProject: false,
  };

  it('nennt das Repository absolut, weil die Sitzung nicht darin sitzt (A70.1)', () => {
    // A relative read in a scratch dir finds an empty directory, and the
    // session then reports in good faith that the change contains nothing.
    const prompt = legalReviewPrompt(change, [source()]);
    expect(prompt).toContain('/data/worktrees/verein/task-7');
    expect(prompt).toContain('absolute path');
    expect(prompt).toContain('src/anmeldung.ts');
  });

  it('übergibt die zitierbaren Quellen mit Kennung und Stufe', () => {
    // There is no MCP surface on the registry, so this list is the only way an
    // id can be known — which is what makes an id outside it a deliberate
    // invention rather than a guess (A56.4's posture for git evidence).
    const prompt = legalReviewPrompt(change, [source()]);
    expect(prompt).toContain(id(1));
    expect(prompt).toContain('L5');
    expect(prompt).toContain('Vereinsgesetz 2002');
  });

  it('sagt einer Sitzung mit leerem Register, dass sie nichts tragen kann', () => {
    // The dangerous alternative is silence: a session shown no sources invents
    // one, and §14's threshold is then decided by whether the invention was
    // plausible.
    const prompt = legalReviewPrompt(change, []);
    expect(prompt).toContain('L4');
    expect(prompt).toMatch(/no accepted source/i);
  });

  it('sagt es, wenn die Liste gekürzt wurde', () => {
    // A session that silently saw two thirds of the registry would cite what it
    // was shown and look as though it had chosen.
    const prompt = legalReviewPrompt(change, [source()], LEGAL_SOURCE_LIST_LIMIT + 12);
    expect(prompt).toContain('further accepted sources not listed here');
  });

  it('stellt die Frage wörtlich, wenn eine gestellt wurde', () => {
    const prompt = legalReviewPrompt(
      {
        kind: 'question',
        question: 'Darf der Verein die Mitgliederliste an den Dachverband weitergeben?',
        taskId: 'aufgabe-8',
        projectId: null,
        readOnlyProject: false,
      },
      [source()],
    );
    expect(prompt).toContain('Darf der Verein die Mitgliederliste an den Dachverband weitergeben?');
    // A question is not a diff: nothing about an integration branch belongs in
    // a prompt that has none, and a leftover `undefined` in one is how a
    // session spends a turn looking for a change that does not exist.
    expect(prompt).not.toContain('merge-base');
    expect(prompt).not.toContain('undefined');
  });

  it('weist auf den Tresor hin, bevor irgendetwas beantwortet wird (§13)', () => {
    const prompt = legalReviewPrompt(change, [source()]);
    expect(prompt).toContain('docs.search');
    expect(prompt).toContain('docs.get');
    expect(prompt).toContain('Statuten');
  });

  it('sagt, dass die Zitationen nachträglich aufgelöst werden', () => {
    // The file header's second rule: telling a session that a rule is enforced
    // is not redundant with enforcing it. A session that does not know spends
    // its turns finding out, and an invented id costs a whole review.
    expect(legalReviewPrompt(change, [source()])).toMatch(/resolved against the registry/i);
  });
});
