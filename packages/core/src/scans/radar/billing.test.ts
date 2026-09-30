/**
 * §6.0's detector, driven from both sides.
 *
 * The positive case is easy and proves little: a rule that matched anything
 * would pass it. What this file is built to fail is the false positive, because
 * A21's arithmetic applies here too — the billing card is P0, and a P0 that
 * fires on a documentation page is a P0 that stops being read. So the negative
 * cases are real pages: Claude Code's own headless documentation, a pricing
 * announcement that is not about programmatic use, and a page that contains both
 * ideas in *different* sentences.
 */
import { describe, expect, it } from 'vitest';
import { detectBillingChange, detectCliRelease, extractCliVersion } from './billing.js';

/** The shape §6.0 describes: the May 2026 announcement, in its own words. */
const ANNOUNCEMENT =
  'Starting 1 September, programmatic usage through claude -p and the Agent SDK ' +
  'will be billed from a separate usage credit instead of counting against your ' +
  'subscription limits.';

describe('detectBillingChange', () => {
  it('erkennt die Ankündigung, die §6.0 beschreibt', () => {
    const signals = detectBillingChange(ANNOUNCEMENT, 'https://example.test/pricing');
    expect(signals).toHaveLength(1);
    expect(signals[0]?.subject).toBe('claude -p');
    expect(signals[0]?.origin).toBe('https://example.test/pricing');
    expect(signals[0]?.sentence).toContain('usage credit');
  });

  it('schweigt zu Dokumentation über headless-Betrieb', () => {
    // Decision 1's whole point. Every one of these carries a subject term.
    const pages = [
      'Claude Code supports headless mode. Use claude -p to run a single prompt.',
      'The Agent SDK lets you build custom agents on top of Claude Code.',
      'Run claude -p in non-interactive environments such as CI.',
    ];
    for (const page of pages) {
      expect(detectBillingChange(page, 'doc'), page).toEqual([]);
    }
  });

  it('schweigt zu einer Preisseite, die programmatische Nutzung nicht nennt', () => {
    const pages = [
      'We have updated pricing for the Max plan. Usage credits are available for API customers.',
      'Extra usage can be purchased at any time from your billing settings.',
    ];
    for (const page of pages) {
      expect(detectBillingChange(page, 'doc'), page).toEqual([]);
    }
  });

  it('verlangt beide Begriffe im selben Satz, nicht auf derselben Seite', () => {
    // The strictness that makes the rule mean anything: a long page will
    // eventually contain both ideas somewhere, and "somewhere" is not a claim.
    const page =
      'Claude Code supports headless mode for scripting.\n' +
      'Separately, our enterprise plans now offer metered add-ons.';
    expect(detectBillingChange(page, 'doc')).toEqual([]);
  });

  it('trennt Sätze auch über Listenpunkte und HTML hinweg', () => {
    const html =
      '<ul><li>Claude Code supports headless mode.</li>' +
      '<li>Enterprise plans include metered add-ons.</li></ul>';
    expect(detectBillingChange(html, 'doc')).toEqual([]);
  });

  it('meldet dieselbe Aussage in einem Text nur einmal', () => {
    // Decision 2, inside one page: a heading and a paragraph saying the same
    // thing is one finding.
    const doubled = `${ANNOUNCEMENT}\n${ANNOUNCEMENT}`;
    expect(detectBillingChange(doubled, 'doc')).toHaveLength(1);
  });

  it('gibt derselben Seite bei jedem Lauf dieselbe Signatur', () => {
    // The property the dedup memory actually needs: an unchanged page is one
    // finding, every six hours, forever.
    const first = detectBillingChange(ANNOUNCEMENT, 'a')[0]?.signature;
    expect(first).toBeDefined();
    expect(detectBillingChange(ANNOUNCEMENT, 'b')[0]?.signature).toBe(first);
  });

  it('übersteht Auszeichnung, Groß-/Kleinschreibung und Leerraum', () => {
    // Same sentence through a different renderer is not an edit (decision 2).
    const rendered = `<p>  ${ANNOUNCEMENT.toUpperCase().replace(/ /g, '  ')}  </p>`;
    expect(detectBillingChange(rendered, 'b')[0]?.signature).toBe(
      detectBillingChange(ANNOUNCEMENT, 'a')[0]?.signature,
    );
  });

  it('vergibt einer umformulierten Ankündigung eine neue Signatur — und das ist gewollt', () => {
    // Decision 2, stated as the assertion that keeps it honest. Stability across
    // rewording is not obtainable from term matching (the first draft claimed it
    // and this test is what disproved it), so the choice is which way to be
    // wrong: an edited page costs one extra P0, and a genuinely different
    // announcement is never missed. For §6.0's #1 external risk that is the
    // right way round.
    const reworded =
      'From September, usage credits will cover programmatic usage of claude -p rather than ' +
      'your plan.';
    const first = detectBillingChange(ANNOUNCEMENT, 'a')[0]?.signature;
    const second = detectBillingChange(reworded, 'b')[0]?.signature;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it('kürzt einen sehr langen Satz und sagt es', () => {
    const padded = `${'x '.repeat(400)}${ANNOUNCEMENT}`;
    const signal = detectBillingChange(padded, 'doc')[0];
    expect(signal?.sentence.endsWith('…')).toBe(true);
    expect(signal?.sentence.length).toBeLessThan(padded.length);
  });
});

describe('extractCliVersion', () => {
  it('liest ein maschinenlesbares Dokument in drei Formen', () => {
    expect(extractCliVersion('{"latest":"2.1.230"}')).toBe('2.1.230');
    expect(extractCliVersion('{"version":"2.1.230"}')).toBe('2.1.230');
    expect(extractCliVersion('{"tag_name":"v2.1.230"}')).toBe('2.1.230');
    expect(extractCliVersion('{"dist-tags":{"latest":"2.1.230"}}')).toBe('2.1.230');
  });

  it('fällt auf die erste Version im Text zurück', () => {
    expect(extractCliVersion('# Changelog\n\n## 2.1.230 — heute\n\n## 2.1.229')).toBe('2.1.230');
  });

  it('gibt null zurück, statt sich etwas auszudenken', () => {
    expect(extractCliVersion('')).toBeNull();
    expect(extractCliVersion('kein Release hier')).toBeNull();
  });

  it('verschluckt sich nicht an einer Klammer, die kein JSON ist', () => {
    expect(extractCliVersion('{ nicht wirklich JSON } 2.1.230')).toBe('2.1.230');
  });
});

describe('detectCliRelease', () => {
  it('meldet einen echten Vorsprung des Kanals', () => {
    expect(detectCliRelease('2.1.220', '2.1.230')).toEqual({
      pinned: '2.1.220',
      latest: '2.1.230',
    });
  });

  it('schweigt bei Gleichstand, Rückschritt und fehlendem Kanal', () => {
    expect(detectCliRelease('2.1.220', '2.1.220')).toBeNull();
    expect(detectCliRelease('2.1.220', '2.1.219')).toBeNull();
    expect(detectCliRelease('2.1.220', null)).toBeNull();
  });

  it('schlägt keine Vorabversion vor', () => {
    // Decision 5: A27's pin exists to make the runner deterministic, and an rc
    // is the opposite of that.
    expect(detectCliRelease('2.1.220', '2.2.0-rc.1')).toBeNull();
  });
});
