/**
 * The settings page's rules, tested where a browser is not needed.
 *
 * `apps/web` has no DOM test environment, so this covers everything about the
 * page that can be wrong without Playwright noticing — the line a desk renders
 * as, and the door a payload comes through. What is left for the browser is
 * that the component actually uses them, which is exactly what `e2e/einstellungen.spec.ts`
 * asserts and what no unit test here could.
 */
import { GATE_CATALOGUE } from '@vorschicht/shared/gates';
import { describe, expect, it } from 'vitest';
import {
  gateKlassen,
  gesetztText,
  komponenteZeile,
  leseEinstellungen,
  leseEinstellungenSeite,
  mailZustand,
  PROTOKOLL_WERT_MAX,
  personaWirkung,
  personaZeile,
  protokollWert,
  protokollZeile,
} from './einstellungen-format.js';

const CLARA = {
  id: 'coder',
  department: 'Entwicklung',
  name: 'Clara',
  desk: 'Entwicklung',
  alternates: ['Chris'],
};
const RITA = {
  id: 'reviewer',
  department: 'Entwicklung',
  name: 'Rita',
  desk: 'Review',
  alternates: [],
};

describe('personaZeile', () => {
  it('names the person while personas are on', () => {
    expect(personaZeile('anzeige', RITA)).toBe('Rita');
    expect(personaZeile('prompt', RITA)).toBe('Rita');
  });

  /** §8's "neutral role labels" — the visible substance of the third state. */
  it('names the role when they are off', () => {
    expect(personaZeile('aus', RITA)).toBe('Review');
  });

  it('carries §8’s second coder while personas are on', () => {
    expect(personaZeile('anzeige', CLARA)).toBe('Clara (auch Chris)');
  });

  /**
   * The half that is easy to leave behind: an alternate is a name, so switching
   * personas off must take it too. A line reading "Entwicklung (auch Chris)"
   * would be personas half-disabled.
   */
  it('drops the second name with the first', () => {
    expect(personaZeile('aus', CLARA)).toBe('Entwicklung');
  });
});

describe('personaWirkung', () => {
  it('says the prompts are untouched below the last step (A9)', () => {
    expect(personaWirkung('aus')).toContain('Wort für Wort');
    expect(personaWirkung('anzeige')).toContain('Wort für Wort');
  });

  it('says what the last step adds', () => {
    expect(personaWirkung('prompt')).toContain('Charakter');
  });
});

describe('leseEinstellungen', () => {
  it('accepts the agreed shape', () => {
    const gelesen = leseEinstellungen({ personas: { mode: 'aus', roster: [RITA] } });
    expect(gelesen.ok).toBe(true);
    if (!gelesen.ok) throw new Error('unerreichbar');
    expect(gelesen.wert.personas.mode).toBe('aus');
  });

  /**
   * A81: a payload is parsed, never cast. The envelope is the exact mistake that
   * shipped once — routes answering `{ posteingang: … }` while the page read
   * `koerper.items`, each side green about its own half.
   */
  it('refuses a payload that is not in its envelope, in German', () => {
    const gelesen = leseEinstellungen({ mode: 'aus', roster: [] });
    expect(gelesen.ok).toBe(false);
    if (gelesen.ok) throw new Error('unerreichbar');
    expect(gelesen.fehler).toContain('vereinbarte Form');
  });

  it('refuses a mode the page could not render', () => {
    expect(leseEinstellungen({ personas: { mode: 'theater', roster: [] } }).ok).toBe(false);
  });
});

/**
 * §17.9s übrige fünf Abschnitte, in ihrer prüfbaren Hälfte.
 *
 * Jeder von ihnen hat genau einen Fehlermodus, den kein Browser bemerkt: ein
 * Mailkanal, der als bereit gemeldet wird, während nichts rausgeht; ein
 * Katalogeintrag, den niemand anhaken kann und der trotzdem unter „optional"
 * steht; und eine Protokollzeile, die eine ganze Gate-Konfiguration in die
 * Überschrift schreibt.
 */
const MAIL_BEREIT = {
  host: 'smtp.example.org',
  port: 465,
  secure: true,
  absender: 'vorschicht@example.org',
  empfaenger: 'max@example.org',
  passwortGesetzt: true,
  einsatzbereit: true,
};

describe('§16s Kanäle auf der Einstellungsseite', () => {
  /**
   * `einsatzbereit` kommt vom Server, aus `missingMailSettings` — derselben
   * Regel, nach der `createMailer` entscheidet. Die Seite leitet es nicht neu
   * her, und dieser Fall hält fest, dass sie es auch nicht überstimmt: sonst
   * meldete sie einen Kanal als bereit, während `DisabledMailer` jede
   * Erinnerung verschluckt (A13).
   */
  it('nennt einen nicht eingerichteten Mailweg genau so, obwohl Felder gesetzt sind', () => {
    const text = mailZustand({ ...MAIL_BEREIT, einsatzbereit: false });
    expect(text).toContain('Nicht eingerichtet');
    expect(text).toContain('ntfy');
    expect(text).not.toContain('smtp.example.org');
  });

  it('nennt Host, Port und Empfänger, wenn der Weg steht', () => {
    const text = mailZustand(MAIL_BEREIT);
    expect(text).toContain('smtp.example.org:465');
    expect(text).toContain('max@example.org');
    expect(text).toContain('TLS');
  });

  /**
   * §16 verlangt einen Wochenbericht und A13 eine tägliche Zusammenfassung —
   * beide brauchen einen Empfänger. Ein leeres Feld darf deshalb nicht als
   * „geht raus" gelesen werden, auch wenn der Versand technisch stünde.
   */
  it('sagt es, wenn der Empfänger fehlt, statt den Satz einfach abzuschneiden', () => {
    expect(mailZustand({ ...MAIL_BEREIT, empfaenger: null })).toContain('REPORT_RECIPIENT');
  });

  it('sagt über ein Geheimnis nur, ob es gesetzt ist (§19)', () => {
    expect(gesetztText(true)).toBe('gesetzt');
    expect(gesetztText(false)).toBe('nicht gesetzt');
  });
});

describe('§18s Sicherungsstand', () => {
  it('übersetzt jedes Ergebnis, „nicht gemeldet" eingeschlossen', () => {
    expect(komponenteZeile({ id: 'db', label: 'Datenbank', ergebnis: 'ok' })).toBe(
      'Datenbank: gelaufen',
    );
    expect(komponenteZeile({ id: 'docs', label: 'Dokumente', ergebnis: 'skipped' })).toBe(
      'Dokumente: nicht erreicht',
    );
    // Der Erzeuger hat diese Komponente gar nicht genannt — das ist eine
    // Abweichung zwischen den beiden Hälften des Dokuments und darf nicht als
    // „in Ordnung" lesbar sein (A103s Ausfall war ein partieller).
    expect(komponenteZeile({ id: 'prune', label: 'Aufräumen', ergebnis: 'unbekannt' })).toBe(
      'Aufräumen: nicht gemeldet',
    );
  });
});

describe('§11s Katalog auf der Einstellungsseite', () => {
  const synthetisch = [
    {
      id: 'test' as const,
      label: 'Tests',
      description: '…',
      locked: true,
      kind: 'command' as const,
      needsCommand: true,
      availableFrom: null,
    },
    {
      id: 'a11y' as const,
      label: 'a11y',
      description: '…',
      locked: false,
      kind: 'command' as const,
      needsCommand: true,
      availableFrom: null,
    },
    {
      id: 'legal' as const,
      label: 'Recht',
      description: '…',
      locked: false,
      kind: 'internal' as const,
      needsCommand: false,
      availableFrom: 'Lena kommt in Phase 6',
    },
  ];

  /**
   * Drei Klassen, und die dritte ist die, die man weglässt: ein Gate mit
   * `availableFrom` kann nicht angehakt werden (A62.3), und es unter „optional"
   * zu zeigen wäre eine Einladung zu einem Versuch, den der Katalog ablehnt.
   */
  it('trennt gesperrt, optional und noch nicht verfügbar', () => {
    const klassen = gateKlassen(synthetisch);
    expect(klassen.map((klasse) => klasse.gates.map((gate) => gate.id))).toEqual([
      ['test'],
      ['a11y'],
      ['legal'],
    ]);
  });

  it('lässt kein Gate des Katalogs unter den Tisch fallen', () => {
    // Über den **echten** Katalog: eine vierte Eigenschaftskombination würde
    // sonst still verschwinden, statt in einer der drei Listen aufzutauchen.
    const gezeigt = gateKlassen().reduce((summe, klasse) => summe + klasse.gates.length, 0);
    expect(gezeigt).toBe(GATE_CATALOGUE.length);
  });
});

describe('§19s Prüfprotokoll', () => {
  const eintrag = {
    id: 7,
    occurredAt: '2026-08-18T09:00:00.000Z',
    actor: 'dashboard:cred-1',
    action: 'project.gate_config_rejected',
    subject: 'vorschicht',
    before: null,
    after: { gates: { test: false } },
  };

  it('nennt Aktion, Gegenstand und Urheber', () => {
    expect(protokollZeile(eintrag)).toBe(
      'project.gate_config_rejected · vorschicht · dashboard:cred-1',
    );
  });

  it('lässt den Gegenstand weg, statt einen leeren Trenner zu drucken', () => {
    expect(protokollZeile({ ...eintrag, subject: null })).toBe(
      'project.gate_config_rejected · dashboard:cred-1',
    );
  });

  it('unterscheidet „nichts vorher" von „leerem Objekt"', () => {
    expect(protokollWert(null)).toBeNull();
    expect(protokollWert(undefined)).toBeNull();
    expect(protokollWert({})).toBe('{}');
  });

  /**
   * Eine ganze Gate-Konfiguration füllt sonst die Seite. Gekürzt wird **mit
   * Ansage** — eine stille Kürzung ist von einem kurzen Wert nicht zu
   * unterscheiden (`docs.get`s Regel, eine Seite weiter).
   */
  it('kürzt einen langen Wert und sagt, dass gekürzt wurde', () => {
    const lang = protokollWert({ text: 'x'.repeat(PROTOKOLL_WERT_MAX * 2) });
    expect(lang).toContain('(gekürzt)');
    expect((lang ?? '').length).toBeLessThan(PROTOKOLL_WERT_MAX + 40);
  });
});

describe('leseEinstellungenSeite', () => {
  it('weist ein Dokument ab, dem ein Abschnitt fehlt', () => {
    const gelesen = leseEinstellungenSeite({
      einstellungen: { personas: { mode: 'anzeige', roster: [] } },
    });
    expect(gelesen.ok).toBe(false);
    if (gelesen.ok) throw new Error('unerreichbar');
    expect(gelesen.fehler).toContain('vereinbarte Form');
  });
});
