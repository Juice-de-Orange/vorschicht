/**
 * The audit result contract (§8.2, A52).
 *
 * These tests guard the two properties that make the Prüfbericht usable rather
 * than merely present: it must commit to a verdict, and it must not accept a
 * finding nobody can check. Both are enforced by the schema, because §6.3 gives
 * exactly one repair re-prompt before a run goes red — a rule stated only in the
 * role prompt is a request, and this one has to be a refusal.
 */
import { describe, expect, it } from 'vitest';
import { parseAgentResult, ROLE_RESULT_SCHEMAS } from './agent-result.js';

/** A complete, valid audit result to vary one field at a time from. */
const AUDIT = {
  status: 'done',
  summary: 'Prüfbericht: Stichprobe von vier Gates geprüft, keine Abweichung.',
  domain: 'gate_truth',
  sample: ['Phase 1 Gate 3', 'Phase 1 Gate 7'],
  findings: [],
  scopeLimits: [],
  verdict: 'unbedenklich',
};

describe('the auditor result contract', () => {
  it('is registered as its own role, not folded into staff', () => {
    // A shared schema would mean the CLI could not be told to demand a verdict,
    // and `--json-schema` is the layer that makes the demand enforceable.
    expect(ROLE_RESULT_SCHEMAS.auditor).toBeDefined();
    expect(ROLE_RESULT_SCHEMAS.auditor).not.toBe(ROLE_RESULT_SCHEMAS.staff);
  });

  it('accepts a complete report', () => {
    const parsed = parseAgentResult('auditor', AUDIT);
    expect(parsed.ok).toBe(true);
  });

  it('offers no neutral verdict to retreat into', () => {
    // The closed set is the point. "Some concerns remain" reads as diligence,
    // commits to nothing, and leaves the one question the reader has — may this
    // phase close? — unanswered.
    for (const verdict of ['teilweise', 'mit_vorbehalt', 'unklar', 'ok', '']) {
      const parsed = parseAgentResult('auditor', { ...AUDIT, verdict });
      expect(parsed.ok, verdict || '<leer>').toBe(false);
    }
    for (const verdict of ['unbedenklich', 'funde_zu_beheben', 'phase_nicht_abschliessbar']) {
      expect(parseAgentResult('auditor', { ...AUDIT, verdict }).ok, verdict).toBe(true);
    }
  });

  it('refuses a finding without evidence — including a suspicion', () => {
    // §8.2: a finding without evidence is not a finding. A suspicion blocks
    // nothing, but it still has to say what prompted it, or the next audit
    // inherits a sentence it cannot act on and cannot dismiss.
    const finding = { class: 'defect', summary: 'Der Meter rundet falsch.' };
    const missing = parseAgentResult('auditor', { ...AUDIT, findings: [finding] });
    expect(missing.ok).toBe(false);

    const empty = parseAgentResult('auditor', {
      ...AUDIT,
      findings: [{ ...finding, evidence: '' }],
    });
    expect(empty.ok).toBe(false);

    const cited = parseAgentResult('auditor', {
      ...AUDIT,
      findings: [{ ...finding, evidence: 'packages/shared/src/usage.ts:42' }],
      verdict: 'funde_zu_beheben',
    });
    expect(cited.ok).toBe(true);

    const suspicion = parseAgentResult('auditor', {
      ...AUDIT,
      findings: [{ class: 'suspicion', summary: 'Wirkt ungeprüft.' }],
    });
    expect(suspicion.ok).toBe(false);
  });

  it('requires the run to state what it could not check', () => {
    // Optional would make silence the default, and an unexamined area reads
    // exactly like a clean one in a report that lists only findings. An
    // auditor with genuinely no limits writes `[]` and has thereby said so.
    const { scopeLimits: _omitted, ...withoutLimits } = AUDIT;
    expect(parseAgentResult('auditor', withoutLimits).ok).toBe(false);
    expect(parseAgentResult('auditor', { ...AUDIT, scopeLimits: [] }).ok).toBe(true);
  });

  it('requires the sample to be recorded, so a later audit can re-check it', () => {
    expect(parseAgentResult('auditor', { ...AUDIT, sample: [] }).ok).toBe(false);
  });

  it('takes `reopens` only as the id of an earlier finding', () => {
    // Written after the first real audit set it to "Phase 1" — a reasonable
    // reading of an unconstrained string field, and one that meant something
    // else entirely. An unconstrained field is a field that will be read the
    // way its name suggests to whoever is looking at it that day, so the shape
    // is now part of the contract and §6.3's repair re-prompt can say so.
    const finding = {
      class: 'defect',
      summary: 'Etwas ist falsch.',
      evidence: 'x.ts:1',
    };
    for (const reopens of ['Phase 1', 'P2.G4', 'der Fund von letzter Woche', '']) {
      const parsed = parseAgentResult('auditor', {
        ...AUDIT,
        verdict: 'funde_zu_beheben',
        findings: [{ ...finding, reopens }],
      });
      expect(parsed.ok, reopens || '<leer>').toBe(false);
      if (!parsed.ok) expect(parsed.problem).toContain('reopens');
    }

    expect(
      parseAgentResult('auditor', {
        ...AUDIT,
        verdict: 'funde_zu_beheben',
        findings: [{ ...finding, reopens: '9f1c1a2e-3b4d-4c5e-8a7b-0123456789ab' }],
      }).ok,
    ).toBe(true);
  });

  it('takes `guard` as free text, because a mechanical guard is a proposal', () => {
    expect(
      parseAgentResult('auditor', {
        ...AUDIT,
        verdict: 'funde_zu_beheben',
        findings: [
          {
            class: 'process',
            summary: 'Eine Regel wurde nicht befolgt.',
            evidence: 'event_log:99',
            guard: 'Gate-Schritt, der einen Merge ohne Gate-Lauf ablehnt.',
          },
        ],
      }).ok,
    ).toBe(true);
  });

  it('names the failing field when it refuses, so the repair prompt can be specific', () => {
    // §6.3 allows one repair re-prompt via --resume. "Invalid" would spend it.
    const parsed = parseAgentResult('auditor', { ...AUDIT, verdict: 'vielleicht' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem).toContain('verdict');
  });
});
