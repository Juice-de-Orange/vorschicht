import { MAX_UPLOAD_BYTES, parseUploadQuery, SEARCH_QUERY } from '@vorschicht/shared/dokumente';
import { describe, expect, it } from 'vitest';
import {
  ALLE_ABTEILUNGEN,
  abteilungenIn,
  abteilungsoptionen,
  DOKUMENTE_PFAD,
  type DocumentVersionView,
  type DocumentView,
  dateitypLabel,
  dokumentDurchsuchbarkeit,
  dokumentKennung,
  dokumentPfad,
  durchsuchbarkeit,
  type Eintrag,
  eintraegeAusSuche,
  eintragAusDetail,
  groesse,
  leseDokument,
  leseSuche,
  MAX_UPLOAD_MB,
  passtZurAbteilung,
  schlagworteAus,
  sucheUrl,
  suchhinweis,
  uploadFehler,
  uploadPlan,
  zusammenfuehren,
} from './dokumente-format.js';
import { segmentAfter } from './router.js';

/**
 * The half of §17.6 that can be broken on purpose without a browser.
 *
 * `apps/web` has no DOM test environment, so everything asserted here is
 * everything about this page a `vitest` run can see at all. The assertions are
 * on exact sentences rather than on "contains something", because two of the
 * three things this page has to get right are wordings: that a stored-but-unread
 * document says so, and that a refusal never renders as silence.
 */

const KENNUNG = '11111111-2222-4333-8444-555555555555';

const dokument = (over: Partial<DocumentView> = {}): DocumentView => ({
  id: KENNUNG,
  title: 'Vereinsstatuten',
  departmentTags: ['Recht'],
  tags: ['Verein', 'Statuten'],
  createdAt: '2026-08-09T10:00:00.000Z',
  updatedAt: '2026-08-09T10:00:00.000Z',
  ...over,
});

const version = (over: Partial<DocumentVersionView> = {}): DocumentVersionView => ({
  id: '99999999-9999-4999-8999-999999999999',
  documentId: KENNUNG,
  version: 1,
  filename: 'statuten.txt',
  mimeType: 'text/plain',
  byteSize: 1234,
  checksum: 'abc',
  extractedChars: 4711,
  uploadedAt: '2026-08-09T10:00:00.000Z',
  uploadedBy: 'dashboard:operator',
  ...over,
});

const datei = (over: Partial<{ name: string; size: number; type: string }> = {}) => ({
  name: 'statuten.txt',
  size: 2048,
  type: 'text/plain',
  ...over,
});

const eintrag = (id: string, abteilungen: string[]): Eintrag => ({
  art: 'treffer',
  dokument: dokument({ id, departmentTags: abteilungen }),
  version: 1,
  departmentMatch: true,
});

describe('der Weg zu einem Dokument', () => {
  it('schreibt den Pfad, den der Leser wieder zerlegt', () => {
    // The round trip is the assertion: either half alone would pass with a link
    // the page cannot read back, which renders as "unbekannt" — i.e. exactly
    // like a document that has been deleted. A81.3 is the entry about what one
    // path written twice cost this project.
    const pfad = dokumentPfad(KENNUNG);
    expect(pfad).toBe(`${DOKUMENTE_PFAD}/${KENNUNG}`);
    expect(dokumentKennung(segmentAfter(pfad, DOKUMENTE_PFAD))).toBe(KENNUNG);
  });

  it('nimmt nur eine uuid an, damit ein Tippfehler nicht als Serverfehler zurückkommt', () => {
    for (const segment of ['', 'abc', '123', `${KENNUNG}x`, 'suche', '../etc/passwd', null]) {
      expect(dokumentKennung(segment)).toBeNull();
    }
    expect(dokumentKennung(KENNUNG.toUpperCase())).toBe(KENNUNG.toUpperCase());
  });

  it('überlebt einen Pfad, den `decodeURIComponent` nicht lesen kann', () => {
    // `/dokumente/%` raises `URIError` inside `segmentAfter`, which runs during
    // render. It has to come back as "keine Kennung" and let the page say so
    // rather than blank the dashboard (A81.5).
    expect(() => segmentAfter(`${DOKUMENTE_PFAD}/%`, DOKUMENTE_PFAD)).not.toThrow();
    expect(dokumentKennung(segmentAfter(`${DOKUMENTE_PFAD}/%`, DOKUMENTE_PFAD))).toBeNull();
  });

  it('baut die Suche aus dem Schlüssel des Vertrags, nicht aus einem zweiten Literal', () => {
    const url = new URL(sucheUrl('  Kündigung  '), 'http://dashboard.invalid');
    expect(url.pathname).toBe('/api/dokumente/suche');
    expect(url.searchParams.get(SEARCH_QUERY.query)).toBe('Kündigung');
    // Kein `abteilung`: der Mensch am Dashboard ist keine Abteilung, und eine
    // erfundene würde seine Treffer nach einer Tatsache umsortieren, die
    // niemand behauptet hat.
    expect(url.searchParams.get(SEARCH_QUERY.department)).toBeNull();
  });
});

describe('eine Antwort des Servers wird gelesen, nicht behauptet', () => {
  it('liest eine Suche und ein Dokument aus ihren Umschlägen', () => {
    const suche = leseSuche({
      dokumente: [
        {
          document: dokument(),
          versionId: version().id,
          version: 1,
          rank: 0.06,
          departmentMatch: true,
          score: 0.072,
        },
      ],
      nochNichtDurchsuchbar: 2,
    });
    expect(suche.ok && suche.wert.nochNichtDurchsuchbar).toBe(2);

    const einzeln = leseDokument({ dokument: { document: dokument(), versions: [version()] } });
    expect(einzeln.ok && einzeln.wert.document.title).toBe('Vereinsstatuten');
    expect(einzeln.ok && einzeln.wert.versions).toHaveLength(1);
  });

  it('sagt auf Deutsch, dass die Antwort nicht die vereinbarte Form hatte', () => {
    // Die Mutation, für die dieser Fall existiert: `lies` durch ein `as`
    // ersetzen. Ein Cast ist eine Behauptung, die niemand prüft — genau so
    // wurde aus `{posteingang:[…]}` einmal eine Karte, die ihren eigenen
    // Umschlag rendert. Ein Parse macht daraus einen Satz auf der Seite.
    const kaputt = leseSuche({ documents: [] });
    expect(kaputt.ok).toBe(false);
    expect(kaputt.ok ? '' : kaputt.fehler).toContain('nicht die vereinbarte Form');

    const falscherUmschlag = leseDokument({ document: { document: dokument(), versions: [] } });
    expect(falscherUmschlag.ok).toBe(false);
  });
});

describe('Beschriftungen', () => {
  it('übersetzt bekannte Dateitypen und reicht unbekannte roh durch', () => {
    expect(dateitypLabel('application/pdf')).toBe('PDF');
    expect(dateitypLabel('text/plain; charset=utf-8')).toBe('Textdatei');
    expect(dateitypLabel('TEXT/MARKDOWN')).toBe('Markdown');
    // Unbekanntes wird gezeigt wie es ankam: ein Typ, den dieses Dashboard
    // nicht kennt, ist eine Abweichung zwischen zwei Hälften dieses Systems,
    // und „Datei" darüber zu schreiben verdeckt genau die.
    expect(dateitypLabel('image/png')).toBe('image/png');
    expect(dateitypLabel(null)).toBe('unbekannter Typ');
  });

  it('schreibt Größen mit deutschem Komma und rundet nichts auf null', () => {
    expect(groesse(400)).toBe('400 Byte');
    expect(groesse(2048)).toBe('2,0 kB');
    expect(groesse(3 * 1024 * 1024)).toBe('3,0 MB');
    expect(groesse(null)).toBe('unbekannt');
  });
});

describe('was „durchsuchbar" für eine Fassung heißt (§13)', () => {
  it('nennt eine abgelegte, aber nicht ausgelesene Datei genau so', () => {
    // Die tragende Zusicherung dieser Datei. Ohne diesen Satz ist ein PDF im
    // Tresor stumm nicht auffindbar, und eine leere Trefferliste liest sich
    // als „nicht vorhanden" statt als „nicht gelesen".
    const antwort = durchsuchbarkeit(
      version({ extractedChars: null, mimeType: 'application/pdf' }),
    );
    expect(antwort.art).toBe('ausstehend');
    expect(antwort.text).toContain('noch nicht durchsuchbar');
    expect(antwort.text).toContain('PDF');
    expect(antwort.text).toContain('abgelegt');
    // Über den Zustand, nicht über die Zukunft: kein Versprechen, das beim
    // Nachrüsten eines Extraktors umformuliert werden müsste.
    expect(antwort.text).not.toMatch(/später|bald|demnächst|wird noch/i);
  });

  it('unterscheidet „nicht gelesen" von „gelesen und leer"', () => {
    const leer = durchsuchbarkeit(version({ extractedChars: 0 }));
    expect(leer.art).toBe('leer');
    expect(leer.text).toContain('keine Textschicht');

    const lesbar = durchsuchbarkeit(version({ extractedChars: 12 }));
    expect(lesbar).toEqual({ art: 'lesbar', zeichen: 12, text: 'durchsuchbar (12 Zeichen Text)' });
  });

  it('nimmt für ein Dokument die beste seiner Fassungen', () => {
    // Eine lesbare Fassung macht das Dokument auffindbar, auch wenn die
    // neueste ein PDF ist — das Gegenteil zu melden wäre falsch in genau der
    // Richtung, die ein funktionierendes Dokument versteckt.
    expect(
      dokumentDurchsuchbarkeit([
        version({ version: 2, extractedChars: null, mimeType: 'application/pdf' }),
        version({ version: 1, extractedChars: 900 }),
      ]).art,
    ).toBe('lesbar');
    expect(dokumentDurchsuchbarkeit([version({ extractedChars: null })]).art).toBe('ausstehend');
    expect(dokumentDurchsuchbarkeit([]).art).toBe('ausstehend');
  });

  it('sagt nach einer Suche, wie viel des Tresors gar nicht gelesen ist', () => {
    expect(suchhinweis(0)).toBeNull();
    expect(suchhinweis(1)).toContain('1 Dokument');
    expect(suchhinweis(3)).toContain('3 Dokumenten');
    expect(suchhinweis(3)).toContain('auf keine Suche passen');
  });
});

describe('die Liste', () => {
  it('setzt Neues nach oben und verdoppelt nichts', () => {
    const alt = [eintrag('a', ['Recht']), eintrag('b', ['Ops'])];
    const neu = [eintrag('b', ['Ops']), eintrag('c', [])];
    expect(zusammenfuehren(neu, alt).map((e) => e.dokument.id)).toEqual(['b', 'c', 'a']);
  });

  it('filtert nach Abteilung, ohne umzusortieren', () => {
    const eintraege = [eintrag('a', ['Recht']), eintrag('b', ['Ops', 'Recht']), eintrag('c', [])];
    expect(eintraege.filter((e) => passtZurAbteilung(e, ALLE_ABTEILUNGEN))).toHaveLength(3);
    expect(
      eintraege.filter((e) => passtZurAbteilung(e, 'Recht')).map((e) => e.dokument.id),
    ).toEqual(['a', 'b']);
    expect(eintraege.filter((e) => passtZurAbteilung(e, 'Legal'))).toHaveLength(0);
    expect(abteilungenIn(eintraege)).toEqual(['Ops', 'Recht']);
  });

  it('behält die gewählte Abteilung im Angebot, auch wenn keine Zeile sie mehr trägt', () => {
    // Ohne diese Zeile ist „gefiltert-leer" unerreichbar: eine Suche **ersetzt**
    // die Zeilen, der Filter überlebt sie, und der Zustand, der sagt „dein
    // Filter verbirgt alles", könnte nie rendern. Ein Zweig, den nichts
    // erreichen kann, liest sich wie Abdeckung und ist keine (§8.2 Domäne 6).
    const nachSuche = [eintrag('b', ['Ops'])];
    expect(abteilungsoptionen(nachSuche, 'Recht')).toEqual(['Ops', 'Recht']);
    // Und keine Verdopplung, wenn sie ohnehin vorkommt.
    expect(abteilungsoptionen(nachSuche, 'Ops')).toEqual(['Ops']);
    expect(abteilungsoptionen(nachSuche, ALLE_ABTEILUNGEN)).toEqual(['Ops']);
  });

  it('kennt die Herkunft einer Zeile', () => {
    const hoch = eintragAusDetail({ document: dokument(), versions: [version()] });
    expect(hoch.art).toBe('hochgeladen');
    expect(hoch.art === 'hochgeladen' && hoch.versionen).toHaveLength(1);

    const gefunden = eintraegeAusSuche({
      dokumente: [
        {
          document: dokument(),
          versionId: version().id,
          version: 3,
          rank: 0.1,
          departmentMatch: false,
          score: 0.1,
        },
      ],
      nochNichtDurchsuchbar: 0,
    });
    expect(gefunden[0]?.art).toBe('treffer');
    expect(gefunden[0]?.art === 'treffer' && gefunden[0].version).toBe(3);
  });
});

describe('was hochgeladen werden darf', () => {
  it('baut genau die Adresse, die die Route wieder zerlegt', () => {
    const plan = uploadPlan({
      titel: '  Vereinsstatuten 2026 ',
      datei: datei(),
      abteilungen: 'Recht, Doku\nRecht',
      schlagworte: 'Verein,Statuten',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    // Builder und Parser in einem Test — die Zusicherung, die gefehlt hat,
    // während `/inbox` und `/posteingang` sich widersprachen (A81.3).
    const params = new URL(plan.url, 'http://dashboard.invalid').searchParams;
    const gelesen = parseUploadQuery(params);
    expect(gelesen.ok).toBe(true);
    if (!gelesen.ok) return;
    expect(gelesen.meta.title).toBe('Vereinsstatuten 2026');
    expect(gelesen.meta.filename).toBe('statuten.txt');
    // Doppeltes „Recht" ist kein zweites Schlagwort.
    expect(gelesen.meta.departmentTags).toEqual(['Recht', 'Doku']);
    expect(gelesen.meta.tags).toEqual(['Verein', 'Statuten']);
    expect(plan.contentType).toBe('text/plain');
  });

  it('weist eine zu große Datei mit Namen und Grenze ab', () => {
    // Die Mutation, für die dieser Fall existiert: den Größenvergleich
    // entfernen. Die Route lehnt danach immer noch ab (A111.1) — was hier
    // verloren ginge, ist die Minute, die eine 60-MB-Datei über eine
    // Hausleitung braucht, bevor jemand erfährt, dass sie zu groß ist.
    const plan = uploadPlan({
      titel: 'Zu groß',
      datei: datei({ name: 'riesig.txt', size: MAX_UPLOAD_BYTES + 1 }),
      abteilungen: '',
      schlagworte: '',
    });
    expect(plan.ok).toBe(false);
    expect(plan.ok ? [] : plan.fehler.join(' ')).toContain('riesig.txt');
    expect(plan.ok ? [] : plan.fehler.join(' ')).toContain(`${MAX_UPLOAD_MB} MB`);
  });

  it('weist einen Dateityp ab, den der Tresor nicht annimmt', () => {
    const plan = uploadPlan({
      titel: 'Bild',
      datei: datei({ name: 'foto.png', type: 'image/png' }),
      abteilungen: '',
      schlagworte: '',
    });
    expect(plan.ok).toBe(false);
    const text = plan.ok ? '' : plan.fehler.join(' ');
    expect(text).toContain('image/png');
    expect(text).toContain('PDF');
    expect(text).toContain('Markdown');
  });

  it('nennt eine fehlende Datei einmal und nicht zweimal', () => {
    const plan = uploadPlan({ titel: 'Ohne Datei', datei: null, abteilungen: '', schlagworte: '' });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.fehler).toHaveLength(1);
    expect(plan.fehler[0]).toContain('Wähle eine Datei');
    // „Der Dateiname fehlt." wäre dieselbe Tatsache ein zweites Mal.
    expect(plan.fehler.join(' ')).not.toContain('Dateiname');
  });

  it('reicht die deutschen Sätze des Vertrags durch, statt sie neu zu erfinden', () => {
    const plan = uploadPlan({ titel: '   ', datei: datei(), abteilungen: '', schlagworte: '' });
    expect(plan.ok).toBe(false);
    expect(plan.ok ? [] : plan.fehler).toContain('Ein Dokument braucht einen Titel.');
  });

  it('gibt niemals eine leere Fehlerliste zurück', () => {
    // Eine leere Liste rendert als nichts, und auf einem Formular, dessen
    // einzige andere Rückmeldung „Abgelegt" ist, liest sich das wie Erfolg.
    const faelle = [
      { titel: '', datei: null, abteilungen: '', schlagworte: '' },
      { titel: 'x', datei: datei({ size: 0 }), abteilungen: '', schlagworte: '' },
      { titel: 'x'.repeat(5000), datei: datei(), abteilungen: '', schlagworte: '' },
      { titel: 'x', datei: datei({ type: '' }), abteilungen: '', schlagworte: '' },
    ];
    for (const fall of faelle) {
      const plan = uploadPlan(fall);
      expect(plan.ok).toBe(false);
      expect(plan.ok ? [] : plan.fehler.length).toBeGreaterThan(0);
    }
  });

  it('zerlegt Schlagworte an Komma und Zeilenumbruch', () => {
    expect(schlagworteAus(' Recht , Ops \n\n Recht \n Doku ')).toEqual(['Recht', 'Ops', 'Doku']);
    expect(schlagworteAus('   ')).toEqual([]);
  });
});

describe('warum der Server abgelehnt hat', () => {
  it('nimmt die Sätze des Servers, wenn er welche mitschickt', () => {
    expect(uploadFehler(422, { errors: ['Ein Dokument braucht einen Titel.'] })).toEqual([
      'Ein Dokument braucht einen Titel.',
    ]);
  });

  it('erfindet für jede Antwort ohne Begründung einen deutschen Satz', () => {
    // Nie leer: eine Antwort ohne Körper — ein Proxy-413, ein Gateway-502 —
    // darf nicht als „hat geklappt" enden.
    for (const status of [401, 404, 413, 415, 500, 502]) {
      const gruende = uploadFehler(status, null);
      expect(gruende.length).toBeGreaterThan(0);
      expect(gruende.join(' ')).not.toMatch(/\b(error|failed|invalid|unsupported)\b/i);
    }
    expect(uploadFehler(413, { errors: [] }).join(' ')).toContain(`${MAX_UPLOAD_MB} MB`);
    expect(uploadFehler(415, {}).join(' ')).toContain('PDF');
  });
});
