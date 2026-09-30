/**
 * The reducer the exit gate rests on, without a browser.
 *
 * The gate measures one mechanism — a frame arrives and a bubble changes — and
 * the browser can only show that it happened quickly. What it *cannot* show is
 * that it happened for the right reason, because a page that re-fetched on every
 * frame would look identical on a fast local machine. So the properties are
 * pinned here: a state change never asks the server, an unknown colleague always
 * does, and a frame about nothing returns the very array it was handed.
 */
import { describe, expect, it } from 'vitest';
import {
  ausgelassenText,
  BUERO_EREIGNISARTEN,
  type BueroDesk,
  DESK_STATE_LABELS,
  deskState,
  type Ereignis,
  platzBegruendung,
  platzName,
  platzZeile,
  SCHNAPPSCHUSS_MS,
  seitZeile,
  wendeEreignisAn,
} from './buero-format.js';

const CLARA: BueroDesk = {
  seatId: 'coder#t1',
  profileId: 'coder',
  department: 'Entwicklung',
  name: 'Clara',
  desk: 'Entwicklung',
  taskId: 't1',
  taskTitle: 'Die Büro-Ansicht bauen',
  taskState: 'coding',
  projectSlug: 'vorschicht',
  projectReadOnly: false,
  runId: 'r1',
  runLive: true,
  since: '2026-08-11T12:03:00.000Z',
};

const PAUL: BueroDesk = {
  ...CLARA,
  seatId: 'planner#t1',
  profileId: 'planner',
  name: 'Paul',
  desk: 'Planung',
  runId: 'r0',
  runLive: false,
};

function raum(...desks: BueroDesk[]): BueroDesk[] {
  return desks.map((desk) => ({ ...desk }));
}

describe('wendeEreignisAn — §9s Wechsel auf den Schreibtisch', () => {
  it('parkt einen Platz aus dem Ereignis heraus, ohne den Server zu fragen', () => {
    const vorher = raum(CLARA);
    expect(deskState(vorher[0] as BueroDesk)).toBe('arbeitet');

    const nachher = wendeEreignisAn(vorher, {
      kind: 'task.state_changed',
      taskId: 't1',
      payload: { from: 'coding', to: 'parked' },
    });

    expect(nachher.brauchtSchnappschuss).toBe(false);
    expect(nachher.desks[0]?.taskState).toBe('parked');
    expect(deskState(nachher.desks[0] as BueroDesk)).toBe('blockiert');
  });

  it('setzt einen fortgesetzten Platz wieder auf „arbeitet"', () => {
    const geparkt = wendeEreignisAn(raum(CLARA), {
      kind: 'task.state_changed',
      taskId: 't1',
      payload: { to: 'parked' },
    });
    const wieder = wendeEreignisAn(geparkt.desks, {
      kind: 'task.state_changed',
      taskId: 't1',
      payload: { to: 'coding' },
    });
    expect(deskState(wieder.desks[0] as BueroDesk)).toBe('arbeitet');
    expect(wieder.brauchtSchnappschuss).toBe(false);
  });

  it('zeigt eine offene Frage als „fragt nach" — der ganze Weg ist ein Feld', () => {
    const nachher = wendeEreignisAn(raum(CLARA), {
      kind: 'task.state_changed',
      taskId: 't1',
      payload: { to: 'needs_decision' },
    });
    expect(deskState(nachher.desks[0] as BueroDesk)).toBe('eskaliert');
    expect(nachher.brauchtSchnappschuss).toBe(false);
  });

  it('ändert alle Plätze derselben Aufgabe, nicht nur den ersten', () => {
    const nachher = wendeEreignisAn(raum(PAUL, CLARA), {
      kind: 'task.state_changed',
      taskId: 't1',
      payload: { to: 'needs_decision' },
    });
    expect(nachher.desks.map((desk) => deskState(desk))).toEqual(['eskaliert', 'eskaliert']);
  });

  /**
   * §7.3s Wrap-up schreibt eine Sammelzeile ohne `taskId`. Wer daraus einen
   * Schnappschuss macht, hat eine Abfrage im Ereignisgewand gebaut.
   */
  it('ignoriert eine Zeile ohne Aufgabe und fragt deswegen nicht nach', () => {
    const vorher = raum(CLARA);
    const nachher = wendeEreignisAn(vorher, {
      kind: 'task.state_changed',
      taskId: null,
      payload: { protocol: 'wrap_up', parked: 3 },
    });
    expect(nachher.desks).toBe(vorher);
    expect(nachher.brauchtSchnappschuss).toBe(false);
  });

  it('ignoriert einen Zustand, den §9 nicht kennt, statt ihn zu rendern', () => {
    const vorher = raum(CLARA);
    const nachher = wendeEreignisAn(vorher, {
      kind: 'task.state_changed',
      taskId: 't1',
      payload: { to: 'in_der_kueche' },
    });
    expect(nachher.desks).toBe(vorher);
  });

  it('ignoriert eine Aufgabe, an der niemand sitzt', () => {
    const vorher = raum(CLARA);
    const nachher = wendeEreignisAn(vorher, {
      kind: 'task.state_changed',
      taskId: 'fremde-aufgabe',
      payload: { to: 'parked' },
    });
    expect(nachher.desks).toBe(vorher);
    expect(nachher.brauchtSchnappschuss).toBe(false);
  });

  it('gibt dieselbe Liste zurück, wenn die Zeile nichts mit dem Büro zu tun hat', () => {
    const vorher = raum(CLARA);
    expect(wendeEreignisAn(vorher, { kind: 'guardian.transition' }).desks).toBe(vorher);
    expect(wendeEreignisAn(vorher, { kind: 'gate.finished' }).desks).toBe(vorher);
  });

  it('räumt einen Platz ab, dessen Aufgabe fertig ist und dessen Sitzung endete', () => {
    const nachher = wendeEreignisAn(raum(PAUL), {
      kind: 'task.state_changed',
      taskId: 't1',
      payload: { to: 'done' },
    });
    expect(nachher.desks).toHaveLength(0);
  });

  it('lässt einen Platz stehen, dessen Sitzung noch läuft — auch bei fertiger Aufgabe', () => {
    const nachher = wendeEreignisAn(raum(CLARA), {
      kind: 'task.state_changed',
      taskId: 't1',
      payload: { to: 'done' },
    });
    expect(nachher.desks).toHaveLength(1);
    expect(deskState(nachher.desks[0] as BueroDesk)).toBe('arbeitet');
  });
});

describe('wendeEreignisAn — Läufe', () => {
  it('setzt einen bekannten Platz wieder auf lebendig, ohne nachzufragen', () => {
    const nachher = wendeEreignisAn(raum(PAUL), {
      kind: 'run.created',
      taskId: 't1',
      runId: 'r7',
      payload: { role: 'planner' },
    });
    expect(nachher.brauchtSchnappschuss).toBe(false);
    expect(nachher.desks[0]?.runLive).toBe(true);
    expect(nachher.desks[0]?.runId).toBe('r7');
  });

  /**
   * Die einzige Stelle, an der das Büro den Server erneut fragt — und der Grund
   * dafür ist konkret: der Strom trägt die Aufgaben-Kennung, nie ihren Titel.
   */
  it('fragt nach, wenn jemand Platz nimmt, den der Raum nicht kennt', () => {
    const vorher = raum(CLARA);
    const nachher = wendeEreignisAn(vorher, {
      kind: 'run.created',
      taskId: 't9',
      runId: 'r9',
      payload: { role: 'reviewer' },
    });
    expect(nachher.brauchtSchnappschuss).toBe(true);
    expect(nachher.desks).toBe(vorher);
  });

  it('beendet die Sitzung des genannten Laufs und lässt den Platz stehen', () => {
    const nachher = wendeEreignisAn(raum(CLARA), {
      kind: 'run.finished',
      runId: 'r1',
      taskId: 't1',
    });
    expect(nachher.desks).toHaveLength(1);
    expect(nachher.desks[0]?.runLive).toBe(false);
    expect(deskState(nachher.desks[0] as BueroDesk)).toBe('ruht');
  });

  it('behandelt einen Abbruch wie ein Ende', () => {
    const nachher = wendeEreignisAn(raum(CLARA), { kind: 'run.interrupted', runId: 'r1' });
    expect(nachher.desks[0]?.runLive).toBe(false);
  });

  /**
   * Ein älterer Lauf desselben Platzes darf den neueren nicht auslöschen —
   * deshalb wird über die Lauf-Kennung gesucht und nicht über den Platz.
   */
  it('leert einen Platz nicht, den inzwischen ein neuerer Lauf besetzt hat', () => {
    const vorher = raum(CLARA);
    const nachher = wendeEreignisAn(vorher, { kind: 'run.finished', runId: 'r0-alt' });
    expect(nachher.desks).toBe(vorher);
    expect(nachher.desks[0]?.runLive).toBe(true);
  });
});

/**
 * Die Liste, die die Seite abonniert, gegen den Reduzierer, der sie behandelt.
 *
 * Genau hier können die zwei Hälften auseinanderlaufen — und der Ausfall wäre
 * unsichtbar: eine Regel, die in jedem Test läuft und im Browser nie. Genau so
 * hat der erste Browserlauf dieser Datei ausgesehen, bloß für *alle* Arten
 * gleichzeitig (`onmessage` statt `addEventListener`).
 */
describe('Abonnierte Ereignisarten', () => {
  const PROBEN: Record<(typeof BUERO_EREIGNISARTEN)[number], Ereignis> = {
    'task.state_changed': { kind: 'task.state_changed', taskId: 't1', payload: { to: 'parked' } },
    'run.created': {
      kind: 'run.created',
      taskId: 't1',
      runId: 'r5',
      payload: { role: 'planner' },
    },
    'run.finished': { kind: 'run.finished', runId: 'r1' },
    'run.interrupted': { kind: 'run.interrupted', runId: 'r1' },
  };

  it('behandelt jede Art, die die Seite bestellt', () => {
    for (const art of BUERO_EREIGNISARTEN) {
      const vorher = raum(PAUL, CLARA);
      const nachher = wendeEreignisAn(vorher, PROBEN[art]);
      expect(nachher.desks, `${art} ändert nichts`).not.toBe(vorher);
    }
  });

  it('bestellt keine Art, die der Reduzierer gar nicht kennt', () => {
    for (const art of BUERO_EREIGNISARTEN) {
      expect(PROBEN[art].kind).toBe(art);
    }
    const vorher = raum(CLARA);
    expect(wendeEreignisAn(vorher, { kind: 'usage.sampled' }).desks).toBe(vorher);
  });
});

describe('Sätze (§2)', () => {
  it('nennt den Aufgabentitel neben der Kugel (§17.2)', () => {
    expect(platzZeile(CLARA)).toBe(`${DESK_STATE_LABELS.arbeitet} · Die Büro-Ansicht bauen`);
  });

  it('sagt es, wenn eine Sitzung gar keine Aufgabe hat (A56.5)', () => {
    const bruno: BueroDesk = { ...CLARA, taskId: null, taskTitle: null, taskState: null };
    expect(platzZeile(bruno)).toContain('ohne Aufgabe');
  });

  it('nennt in der Begründung, welche Art von blockiert gemeint ist', () => {
    const geparkt: BueroDesk = { ...CLARA, taskState: 'parked', runLive: false };
    const gesperrt: BueroDesk = {
      ...CLARA,
      taskState: 'coding',
      runLive: false,
      projectReadOnly: true,
    };
    expect(deskState(geparkt)).toBe('blockiert');
    expect(deskState(gesperrt)).toBe('blockiert');
    // Dieselbe Kugel, zwei verschiedene nächste Schritte — und die Begründung
    // muss sie unterscheiden, sonst ist die Kugel eine Sackgasse.
    expect(platzBegruendung(geparkt)).not.toBe(platzBegruendung(gesperrt));
    expect(platzBegruendung(gesperrt)).toContain('Nur-Lesen');
  });

  it('zeigt den Namen nur, solange Personas an sind (§8, A9)', () => {
    expect(platzName(CLARA, 'anzeige')).toBe('Clara');
    expect(platzName(CLARA, 'prompt')).toBe('Clara');
    expect(platzName({ ...CLARA, desk: 'Planung' }, 'aus')).toBe('Planung');
  });

  it('zeigt die Uhrzeit, nicht eine mitlaufende Dauer', () => {
    expect(seitZeile(CLARA)).toMatch(/^seit \d{2}:\d{2}$/);
    expect(seitZeile({ ...CLARA, since: null })).toBeNull();
    expect(seitZeile({ ...CLARA, since: 'gestern' })).toBeNull();
  });

  it('sagt es, wenn der Deckel Plätze verschweigt', () => {
    expect(ausgelassenText(0)).toBeNull();
    expect(ausgelassenText(1)).toContain('1 weiterer Platz');
    expect(ausgelassenText(5)).toContain('5 weitere Plätze');
  });

  it('hält den Rückfall-Takt langsam genug, dass er nicht als Live durchgeht', () => {
    // Die Messung des Gates wäre sonst eine Aussage über die Abfrage.
    expect(SCHNAPPSCHUSS_MS).toBeGreaterThanOrEqual(10_000);
  });
});
