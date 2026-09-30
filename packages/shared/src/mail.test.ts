/**
 * §16's "e-mail renders correctly (HTML + plain)", as a statement that can fail.
 *
 * The gate sentence is easy to satisfy dishonestly: return two strings and both
 * halves of "HTML and plain" are technically present. So the assertions here are
 * about the *facts* in each part rather than about the parts existing — the
 * number, the deep link, the question and the German have to be in both, because
 * a mail client that refuses HTML shows the text part and a preview line shows
 * nothing else at all.
 */
import { describe, expect, it } from 'vitest';
import { INBOX_PATH } from './constants.js';
import {
  ageLabel,
  type EscalationMailItem,
  esc,
  inboxUrl,
  renderDigestMail,
  renderReminderMail,
} from './mail.js';

const ORIGIN = 'https://vorschicht.example.com';
const RAISED = new Date('2026-08-01T09:00:00Z');
const NOW = new Date('2026-08-02T11:00:00Z').getTime(); // 26 h later

const item: EscalationMailItem = {
  number: 12,
  urgency: 'P1',
  source: 'agent_question',
  question: 'Darf Vorschicht die Abhängigkeit „undici" ergänzen?',
  context:
    'Der Läufer braucht einen HTTP-Klienten mit Zeitüberschreitung. <script>alert(1)</script>',
  raisedAt: RAISED,
  options: [
    { title: 'Ergänzen', recommended: true },
    { title: 'Selbst bauen', recommended: false },
  ],
};

describe('renderReminderMail', () => {
  const mail = renderReminderMail(item, { publicOrigin: ORIGIN, now: NOW });

  it('carries the number, the question and the deep link in BOTH parts', () => {
    for (const part of [mail.text, mail.html]) {
      expect(part).toContain('#12');
      expect(part).toContain('Darf Vorschicht die Abhängigkeit');
      expect(part).toContain(inboxUrl(ORIGIN, 12));
    }
  });

  it('names the waiting time and the source in German (§2)', () => {
    expect(mail.subject).toBe('Vorschicht: Entscheidung #12 wartet seit 26 Stunden');
    expect(mail.text).toContain('Frage aus einer Sitzung');
    expect(mail.text).toContain('Dringlichkeit: P1');
    // Nothing English leaks in from a template: these are the words that would.
    expect(mail.text).not.toMatch(/\b(decision|pending|reminder|options)\b/i);
  });

  it('marks exactly the recommended option, in both parts', () => {
    expect(mail.text).toContain('1. Ergänzen (Empfehlung)');
    expect(mail.text).toContain('2. Selbst bauen');
    expect(mail.text).not.toContain('Selbst bauen (Empfehlung)');
    expect(mail.html).toContain('<li>Ergänzen <em>(Empfehlung)</em></li>');
    expect(mail.html).toContain('<li>Selbst bauen</li>');
  });

  // Everything rendered here was written by a language model or by the operator, and it
  // lands in a document a mail client parses.
  it('escapes markup in the HTML part and leaves the text part verbatim', () => {
    expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(mail.html).not.toContain('<script>');
    expect(mail.text).toContain('<script>alert(1)</script>');
  });

  it('is a complete HTML document, so a client has something to parse', () => {
    expect(mail.html.startsWith('<!doctype html>')).toBe(true);
    expect(mail.html).toContain('lang="de"');
    expect(mail.html.endsWith('</html>')).toBe(true);
  });
});

describe('renderDigestMail', () => {
  const second: EscalationMailItem = {
    ...item,
    number: 13,
    urgency: 'P0',
    source: 'task_red',
    question: 'Aufgabe „Migration 0018" ist zweimal gescheitert — wie weiter?',
    raisedAt: new Date('2026-08-02T10:30:00Z'),
  };
  const mail = renderDigestMail([second, item], { publicOrigin: ORIGIN, now: NOW });

  it('lists every open item with its own link, in both parts', () => {
    for (const part of [mail.text, mail.html]) {
      expect(part).toContain(inboxUrl(ORIGIN, 12));
      expect(part).toContain(inboxUrl(ORIGIN, 13));
      expect(part).toContain('Zweiter Fehlschlag');
      expect(part).toContain('Frage aus einer Sitzung');
    }
  });

  it('counts in the subject, and declines the singular correctly', () => {
    expect(mail.subject).toBe('Vorschicht: 2 Entscheidungen warten');
    expect(renderDigestMail([item], { publicOrigin: ORIGIN, now: NOW }).subject).toBe(
      'Vorschicht: 1 Entscheidung wartet',
    );
  });

  // A digest that reproduced every card would be unreadable at three items.
  it('leaves the context out — the link leads to the card that has it', () => {
    expect(mail.text).not.toContain('Der Läufer braucht');
    expect(mail.html).not.toContain('Der Läufer braucht');
  });

  it('keeps the order it was given, which is the inbox order (§17.5)', () => {
    expect(mail.text.indexOf('#13')).toBeLessThan(mail.text.indexOf('#12'));
  });
});

describe('ageLabel', () => {
  it('speaks German and declines the singular', () => {
    expect(ageLabel(60_000)).toBe('seit 1 Minute');
    expect(ageLabel(5 * 60_000)).toBe('seit 5 Minuten');
    expect(ageLabel(60 * 60_000)).toBe('seit 1 Stunde');
    expect(ageLabel(26 * 60 * 60_000)).toBe('seit 26 Stunden');
    expect(ageLabel(72 * 60 * 60_000)).toBe('seit 3 Tagen');
  });

  it('never reports a negative age — a clock skew is not "seit -3 Minuten"', () => {
    expect(ageLabel(-90_000)).toBe('seit 0 Minuten');
  });
});

describe('inboxUrl', () => {
  it('does not double the slash when the origin carries one', () => {
    // The path is asserted against the constant the dashboard routes on, not
    // against a literal. A literal here is exactly how this drifted: `inboxUrl`
    // said `/inbox` for weeks while the router said `/posteingang`, and this
    // test was green the whole time because it agreed with the wrong half.
    expect(inboxUrl('https://x.example/', 7)).toBe(`https://x.example${INBOX_PATH}/7`);
    expect(inboxUrl('https://x.example', 7)).toBe(`https://x.example${INBOX_PATH}/7`);
  });
});

describe('esc', () => {
  it('escapes for attribute context as well as text context', () => {
    expect(esc(`<a href="x" title='y'>&`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;',
    );
  });
});
