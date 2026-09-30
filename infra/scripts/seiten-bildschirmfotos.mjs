#!/usr/bin/env node
/**
 * Bildschirmfotos der neun übrigen Seiten (§17.3–§17.9) — der eigentliche
 * Nachweis für eine Gestaltung.
 *
 * Ein Test kann sagen, dass ein Knopf klickbar ist und ein Zustand ankommt; das
 * tun die 65 Browserfälle gegen die echte API und echte Zeilen, und sie werden
 * davon nicht berührt. Was kein Test sagen kann, ist ob eine Seite **aussieht**
 * wie ein Schreibtisch — und der Betreiber liest keine Beschreibungen von Aussehen, er
 * sieht es sich an.
 *
 * **Warum ein eigener Server statt der Browserstrecke.** Dasselbe Argument wie
 * in `buero-bildschirmfotos.mjs`, eine Etage breiter: die Strecke braucht
 * Postgres, eine Passkey-Zeremonie und gesäte Zeilen in neun Tabellen. Für ein
 * Bild ist das Aufwand ohne Ertrag — und mehrere Zustände, die hier gezeigt
 * werden müssen, sind über die echte API gar nicht bequem herstellbar (ein
 * Fenster ohne Messung, eine Quelle mit drei Verlaufsstationen, ein PDF ohne
 * Textschicht). Hier liefert ein winziger HTTP-Server **das gebaute Bundle**
 * aus — dieselbe Datei, die nginx ausliefert (A120) — und beantwortet die
 * Endpunkte mit vertragskonformen Nutzlasten.
 *
 * Was das beweist und was nicht, ausdrücklich: bewiesen ist, wie die **echten**
 * Komponenten eine vertragskonforme Antwort zeichnen. Die Nutzlasten unten
 * gehen durch dieselben zod-Schemata wie in Produktion (A81) — passt eine
 * nicht, rendert die Seite ihren deutschen Fehlersatz statt der Ansicht, und
 * das Bild zeigt es. Nicht bewiesen ist, dass der Server diese Antworten so
 * baut; das ist die Zusicherung der Browserstrecke und der `*.itest.ts`.
 *
 * Aufruf: `node infra/scripts/seiten-bildschirmfotos.mjs`
 * Exit-Codes nach A25/A50: **2** heisst „nichts geprüft" (kein Browser, kein
 * Bundle), **1** heisst „ein Bild kam nicht zustande oder eine Seite hat ihren
 * Fehlerzustand gezeichnet".
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';

const WURZEL = resolve(import.meta.dirname, '../..');
const DIST = join(WURZEL, 'apps/web/dist');
const ZIEL = join(WURZEL, 'docs/media');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
};

/*
 * Echte uuids, keine sprechenden Kennungen: `spurKennung` und `dokumentKennung`
 * prüfen die Form, und ein `aufgabe-1` in der Adresse ist für die Seite ein
 * **kaputter Link** — sie zeichnet dann völlig korrekt „das ist keine
 * Aufgabenkennung". Beim ersten Lauf war genau das der Grund, warum drei Seiten
 * kein Bild bekommen haben; der Fehlschlag hat also getan, wofür er da ist.
 */
const AUFGABE_ID = '11111111-1111-4111-8111-111111111111';
const AUFGABE_2_ID = '22222222-2222-4222-8222-222222222222';
const AUFGABE_3_ID = '33333333-3333-4333-8333-333333333333';
const AUFGABE_7_ID = '77777777-7777-4777-8777-777777777777';
const LAUF_ID = '44444444-4444-4444-8444-444444444444';
const LAUF_0_ID = '55555555-5555-4555-8555-555555555555';

/*
 * Jetzt, nicht ein fester Zeitpunkt: die Seiten rechnen Restlaufzeiten aus
 * (`restzeit`, `zeitpunkt`), und ein eingefrorenes „jetzt" in der Vergangenheit
 * lässt jedes Fenster „abgelaufen" melden — ein Zustand, der auf einem Bild über
 * Gestaltung nichts zu suchen hat. Der Preis ist, dass zwei Läufe nicht
 * bytegleiche Bilder erzeugen; die Zusicherung dieses Skripts ist ohnehin der
 * gezeichnete Zustand, nicht ein Vergleich mit einem Vorbild.
 */
const JETZT = Date.now();
const iso = (minutenHer) => new Date(JETZT - minutenHer * 60_000).toISOString();

// ---------------------------------------------------------------------------
// Die Nutzlasten
// ---------------------------------------------------------------------------

/**
 * §15s Karte. Zwei Optionen, genau eine davon empfohlen — die Regel, die man
 * auf dem Bild **sehen** muss, ohne sie zu lesen.
 */
const KARTE = {
  id: 'esk-1',
  number: 42,
  source: 'agent_question',
  sourceLabel: 'Frage aus einer Sitzung',
  urgency: 'P1',
  projectId: 'vorschicht',
  taskId: AUFGABE_ID,
  runId: LAUF_ID,
  question: 'Darf der Bot die Migration 0023 ohne Rückwärtskompatibilität ausrollen?',
  context:
    'Die Migration entfernt die Spalte `legacy_state`, die das vorige Release noch liest. ' +
    '§12 rollt nach einem grünen Merge selbst aus und stellt bei einer roten Gesundheitsprüfung ' +
    'den vorigen **Code** wieder her — an den Daten macht das nichts rückgängig. Der Rollout ' +
    'steht deshalb an und wartet auf dich; die Aufgabe hält ihre Claims so lange.',
  options: [
    {
      index: 0,
      title: 'Warten — ich mache die Migration erst rückwärtskompatibel',
      pros: [
        'Ein Rollback stellt danach wirklich den vorigen Stand her.',
        'Kostet nichts ausser einer weiteren Runde durch die Gates.',
      ],
      cons: ['Der Rollout liegt bis dahin still.'],
      recommended: true,
    },
    {
      index: 1,
      title: 'Trotzdem ausrollen — ich nehme die Einbahnstrasse in Kauf',
      pros: ['Das Release geht heute raus.'],
      cons: [
        'Ein Rollback stellt danach nur den Code her, nicht die Daten.',
        'Der Weg zurück führt über eine Sicherung von 02:30.',
      ],
      recommended: false,
    },
  ],
  related: [
    {
      number: 31,
      question: 'Darf der Bot auf den Integrationszweig pushen?',
      summary: 'Gewählt: Nur über die Merge-Queue, nie direkt.',
      decidedAt: iso(60 * 26),
    },
  ],
  raisedAt: iso(37),
  raisedBy: 'db-review',
  state: 'open',
  answeredAt: null,
  answeredBy: null,
  chosenIndex: null,
  chosenTitle: null,
  freeText: null,
};

const ZWEITE_KARTE = {
  ...KARTE,
  id: 'esk-2',
  number: 43,
  source: 'rollback',
  sourceLabel: 'Rollback',
  urgency: 'P0',
  taskId: AUFGABE_2_ID,
  question: 'Der Rollout von 9f3c1a wurde zurückgerollt — wie weiter?',
  context:
    'Die Gesundheitsprüfung antwortete 90 Sekunden lang mit HTTP 503. §12 hat automatisch auf ' +
    'aaaaaaaaaa (e2e:gut) zurückgerollt; die Produktion antwortet wieder. Was noch offen ist, ' +
    'ist die Ursache — und ob der nächste Versuch von selbst laufen darf.',
  options: [
    {
      index: 0,
      title: 'Ursache suchen lassen — Debugger auf die Aufgabe setzen',
      pros: ['Der nächste Versuch geht mit einer Diagnose los statt blind.'],
      cons: ['Kostet eine Sitzung der stärksten Stufe.'],
      recommended: true,
    },
    {
      index: 1,
      title: 'Ich sehe selbst auf dem Server nach',
      pros: ['Du siehst die Container-Logs, die das Studio nicht hat.'],
      cons: ['Das Studio wartet, bis du antwortest.'],
      recommended: false,
    },
  ],
  related: [],
  raisedAt: iso(8),
};

const ENTSCHEIDUNGEN = [
  {
    escalationId: 'esk-31',
    number: 31,
    source: 'agent_question',
    sourceLabel: 'Frage aus einer Sitzung',
    projectId: 'vorschicht',
    taskId: AUFGABE_7_ID,
    question: 'Darf der Bot auf den Integrationszweig pushen?',
    summary: 'Gewählt: Nur über die Merge-Queue, nie direkt.',
    options: [],
    chosenIndex: 0,
    chosenTitle: 'Nur über die Merge-Queue, nie direkt',
    freeText: null,
    decidedAt: iso(60 * 26),
    decidedBy: 'dashboard:operator',
  },
  {
    escalationId: 'esk-28',
    number: 28,
    source: 'gate_proposal',
    sourceLabel: 'Vorschlag zur Gate-Konfiguration',
    projectId: 'example-app',
    taskId: null,
    question: 'Welche Gates soll Example App bekommen?',
    summary:
      'In eigenen Worten: „Die sechs gesperrten plus SAST und Lizenzen. Das Test-Gate muss die ' +
      'übersprungenen Fälle zählen, nicht den Rückgabewert."',
    options: [],
    chosenIndex: null,
    chosenTitle: null,
    freeText:
      'Die sechs gesperrten plus SAST und Lizenzen. Das Test-Gate muss die übersprungenen ' +
      'Fälle zählen, nicht den Rückgabewert.',
    decidedAt: iso(60 * 51),
    decidedBy: 'dashboard:operator',
  },
];

/**
 * §17.8s Fenster. Bewusst alle vier Vertrauensstufen nebeneinander: dass eine
 * **Schätzung** nicht aussieht wie eine **Messung**, ist die tragende
 * Unterscheidung dieser Seite (A64/A73), und ein Bild mit nur einer Stufe zeigt
 * sie nicht.
 */
const FENSTER = [
  {
    window: 'five_hour',
    modelClass: null,
    usedPercent: 41.8,
    resetsAt: JETZT + 2 * 3600_000,
    source: 'estimated',
    anomaly: null,
    vertrauen: {
      stufe: 'geschaetzt',
      satz:
        'Eigene Schätzung aus den Kosten-Äquivalenten der Sitzungen. Der Anbieter liefert erst ' +
        'ab 75 % eine eigene Zahl (A73), darunter gibt es keine zum Vergleichen. Der Wächter ' +
        'räumt bei geschätzten Zahlen deshalb früher auf.',
    },
  },
  {
    window: 'seven_day',
    modelClass: null,
    usedPercent: 88.4,
    resetsAt: JETZT + 3 * 24 * 3600_000,
    source: 'official',
    anomaly: null,
    vertrauen: { stufe: 'offiziell', satz: 'Zahl des Anbieters, nicht geschätzt.' },
  },
  {
    window: 'seven_day_model',
    modelClass: 'opus',
    usedPercent: 96.2,
    resetsAt: JETZT + 5 * 24 * 3600_000,
    source: 'official',
    anomaly: 'divergence',
    vertrauen: {
      stufe: 'strittig',
      satz:
        'Die offizielle Messung und die Schätzung widersprechen sich. Es gilt die offizielle ' +
        'Zahl; die Abweichung ist als Controlling-Anomalie vermerkt (§7.1).',
    },
  },
  {
    window: 'seven_day_model',
    modelClass: 'haiku',
    usedPercent: 0,
    resetsAt: null,
    source: 'estimated',
    anomaly: 'unavailable',
    vertrauen: {
      stufe: 'blind',
      satz:
        'Das Budget ist gerade nicht lesbar. Der Wächter hält deshalb an, statt weiterzumachen ' +
        '— eine unlesbare Anzeige ist kein freies Budget (§7.1).',
    },
  },
];

const VERLAUF = Array.from({ length: 24 }, (_, i) => [
  {
    window: 'five_hour',
    modelClass: null,
    usedPercent: 20 + 22 * Math.abs(Math.sin(i / 3.1)),
    source: 'estimated',
    observedAt: JETZT - (23 - i) * 3600_000,
  },
  {
    window: 'seven_day',
    modelClass: null,
    usedPercent: 62 + i,
    source: 'official',
    observedAt: JETZT - (23 - i) * 3600_000,
  },
]).flat();

const CONTROLLING = {
  controlling: {
    waechter: {
      state: 'wrap_up',
      text: 'Ab 85 % startet nichts Neues mehr; laufende Arbeit wird sauber geparkt.',
      governingWindow: 'seven_day',
      since: iso(19),
    },
    schwellen: { wrapUpPercent: 85, hardStopPercent: 95, degradedWrapUpPercent: 75 },
    fenster: FENSTER,
    verlauf: VERLAUF,
    pause: { modus: 'normal', unlesbar: false },
    sparbetrieb: {
      aktiv: false,
      unlesbar: false,
      wirkungen: [
        {
          id: 'idle_audits',
          text: 'Leerlauf-Audits laufen nicht mehr.',
          wirksam: true,
          verdrahtung: 'Der Ablaufplaner liest den Schalter vor jedem Leerlauf-Slot.',
          offen: null,
        },
        {
          id: 'tier',
          text: 'Alle Rollen ausser der Reviewerin fallen auf die Standardstufe.',
          wirksam: false,
          verdrahtung: 'resolveTier kennt die Regel.',
          offen: 'Der Ablaufplaner liest sie beim Start und nicht beim Umlegen.',
        },
        {
          id: 'concurrency',
          text: 'Nebenläufigkeit auf 1.',
          wirksam: false,
          verdrahtung: 'Der Wert steht in der Konfiguration.',
          offen: 'Kein Leser ausserhalb des Starts.',
        },
        {
          id: 'radar',
          text: 'Radar nur noch wöchentlich.',
          wirksam: false,
          verdrahtung: 'Die Kadenz ist beschrieben.',
          offen: 'Der Taktgeber liest den Schalter nicht.',
        },
      ],
      stufen: [
        {
          profileId: 'reviewer',
          department: 'Entwicklung',
          normal: 'opus-class',
          sparbetrieb: 'opus-class',
        },
        {
          profileId: 'coder',
          department: 'Entwicklung',
          normal: 'sonnet-class',
          sparbetrieb: 'sonnet-class',
        },
        {
          profileId: 'planner',
          department: 'Entwicklung',
          normal: 'opus-class',
          sparbetrieb: 'sonnet-class',
        },
        {
          profileId: 'auditor',
          department: 'Betriebsprüfung',
          normal: 'opus-class',
          sparbetrieb: 'opus-class',
        },
      ],
    },
    betrieb: {
      planProfile: 'max_20x',
      concurrency: 2,
      concurrencyRange: { min: 0, max: 4 },
    },
  },
};

const PERSONAS = {
  personas: {
    mode: 'anzeige',
    roster: [
      { id: 'planner', department: 'Entwicklung', name: 'Paul', desk: 'Planung', alternates: [] },
      {
        id: 'coder',
        department: 'Entwicklung',
        name: 'Clara',
        desk: 'Umsetzung',
        alternates: ['Chris'],
      },
      { id: 'reviewer', department: 'Entwicklung', name: 'Rita', desk: 'Review', alternates: [] },
      { id: 'qa', department: 'QA/Testing', name: 'Quentin', desk: 'Prüfstand', alternates: [] },
      { id: 'security', department: 'Security', name: 'Sasha', desk: 'Sicherheit', alternates: [] },
      { id: 'legal', department: 'Legal/Compliance', name: 'Lena', desk: 'Recht', alternates: [] },
      { id: 'ops', department: 'Ops/SRE', name: 'Otto', desk: 'Betrieb', alternates: [] },
      {
        id: 'auditor',
        department: 'Betriebsprüfung',
        name: 'Bruno',
        desk: 'Prüfung',
        alternates: [],
      },
    ],
  },
};

const PROJEKTE = {
  projekte: [
    {
      id: 'p-1',
      slug: 'vorschicht',
      name: 'Vorschicht',
      rootPath: '/opt/vorschicht',
      defaultBranch: 'main',
      selfManaged: true,
      readOnly: true,
      active: true,
      gateConfig: {
        gates: { sast: true, licenses: true },
        commands: {
          test: 'pnpm gate:test',
          typecheck: 'pnpm gate:typecheck',
          lint: 'pnpm gate:lint',
          build: 'pnpm gate:build',
          sast: 'pnpm run sast',
          licenses: 'pnpm run licenses',
        },
        tools: ['Bash(pnpm:*)', 'Bash(git:*)'],
        migrationPaths: ['packages/db/migrations/**'],
      },
      resolvedGateIds: [
        'test',
        'typecheck',
        'lint',
        'secrets',
        'build',
        'review',
        'sast',
        'licenses',
      ],
      releases: [
        {
          id: 'd-3',
          projectId: 'p-1',
          sha: 'cccccccccccccccccccccccccccccccccccccccc',
          method: 'compose',
          artifact: 'image:cccccccccc',
          outcome: 'failed',
          lastStep: 'migrate',
          finishedAt: iso(41),
          taskId: AUFGABE_ID,
          problem: 'Migration 0023 ist nicht rückwärtskompatibel — der Rollout wurde angehalten.',
          startedAt: iso(41),
          durationMs: 812,
          rolledBackTo: null,
        },
        {
          id: 'd-2',
          projectId: 'p-1',
          sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          method: 'compose',
          artifact: 'image:bbbbbbbbbb',
          outcome: 'rolled_back',
          lastStep: 'health',
          finishedAt: iso(95),
          taskId: AUFGABE_2_ID,
          problem: 'HTTP 503 über die volle Zeitgrenze.',
          startedAt: iso(96),
          durationMs: 41_900,
          rolledBackTo: {
            deploymentId: 'd-1',
            sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            artifact: 'image:aaaaaaaaaa',
          },
        },
        {
          id: 'd-1',
          projectId: 'p-1',
          sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          method: 'compose',
          artifact: 'image:aaaaaaaaaa',
          outcome: 'succeeded',
          lastStep: 'health',
          finishedAt: iso(179),
          taskId: AUFGABE_7_ID,
          problem: null,
          startedAt: iso(180),
          durationMs: 18_400,
          rolledBackTo: null,
        },
      ],
      releaseSource: 'records',
    },
    {
      id: 'p-2',
      slug: 'example-app',
      name: 'Example App',
      rootPath: '/opt/example-app',
      defaultBranch: 'main',
      selfManaged: false,
      readOnly: false,
      active: true,
      gateConfig: { gates: {}, commands: {}, tools: [], migrationPaths: [] },
      resolvedGateIds: ['test', 'typecheck', 'lint', 'secrets', 'build', 'review'],
      releases: [],
      releaseSource: 'records',
    },
  ],
};

const DOKUMENT_TEXT = {
  id: '11111111-2222-4333-8444-555555555555',
  title: 'Vereinsstatuten 2026',
  departmentTags: ['Recht', 'Doku'],
  tags: ['Verein', 'Statuten'],
  createdAt: iso(60 * 30),
  updatedAt: iso(60 * 30),
};

const DOKUMENT_PDF = {
  id: '66666666-7777-4888-8999-aaaaaaaaaaaa',
  title: 'Auftragsverarbeitungsvertrag (Entwurf)',
  departmentTags: ['Recht'],
  tags: ['AVV', 'DSGVO'],
  createdAt: iso(60 * 4),
  updatedAt: iso(60 * 4),
};

const FASSUNG_TEXT = {
  id: 'v-1',
  documentId: DOKUMENT_TEXT.id,
  version: 1,
  filename: 'statuten-2026.md',
  mimeType: 'text/markdown',
  byteSize: 24_118,
  checksum: 'b7f0…',
  extractedChars: 23_804,
  uploadedAt: iso(60 * 30),
  uploadedBy: 'dashboard:operator',
};

const FASSUNG_PDF = {
  id: 'v-2',
  documentId: DOKUMENT_PDF.id,
  version: 1,
  filename: 'avv-entwurf.pdf',
  mimeType: 'application/pdf',
  byteSize: 412_004,
  checksum: '3ac9…',
  extractedChars: null,
  uploadedAt: iso(60 * 4),
  uploadedBy: 'dashboard:operator',
};

const QUELLE = {
  id: '99999999-8888-4777-8666-555555555555',
  url: 'https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10000228',
  documentId: null,
  title: 'Vereinsgesetz 2002 — geltende Fassung (RIS)',
  assessment: 'Amtlicher Volltext des Bundeskanzleramts; primäre Rechtsquelle.',
  proposedLevel: 5,
  level: 4,
  state: 'accepted',
  stateLabel: 'aufgenommen',
  stateReason: null,
  levelReason: 'Als Normungsgremium anerkannt; Volltext stichprobenartig geprüft.',
  proposedAt: iso(60 * 72),
  proposedBy: 'research',
  curatedAt: iso(60 * 70),
  curatedBy: 'dashboard:operator',
  score: 4.17,
  acts: ['level', 'retire'],
  citable: true,
};

const QUELLE_VORSCHLAG = {
  ...QUELLE,
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  url: 'https://blog.example.org/dsgvo-und-vereine',
  title: 'DSGVO und Vereine — was 2026 gilt (Blog)',
  assessment: 'Sekundärquelle, gut belegt, aber nicht amtlich.',
  proposedLevel: 3,
  level: null,
  state: 'proposed',
  stateLabel: 'vorgeschlagen',
  levelReason: null,
  curatedAt: null,
  curatedBy: null,
  score: null,
  acts: ['accept', 'reject'],
  citable: false,
};

const QUELLE_DETAIL = {
  quelle: {
    source: QUELLE,
    history: [
      {
        seq: 1,
        kind: 'proposed',
        label: 'vorgeschlagen mit L5',
        occurredAt: iso(60 * 72),
        actor: 'research',
        level: 5,
        reason: null,
        note: null,
      },
      {
        seq: 2,
        kind: 'accepted',
        label: 'aufgenommen auf L3',
        occurredAt: iso(60 * 70),
        actor: 'dashboard:operator',
        level: 3,
        reason: null,
        note: 'Fassung stichprobenartig geprüft.',
      },
      {
        seq: 3,
        kind: 'level_changed',
        label: 'auf L4 gesetzt',
        occurredAt: iso(60 * 20),
        actor: 'dashboard:operator',
        level: 4,
        reason: 'Als Normungsgremium anerkannt; Volltext stichprobenartig geprüft.',
        note: null,
      },
    ],
  },
};

const AUFGABE_ZEILE = {
  id: AUFGABE_ID,
  title: 'Migration 0023 rückwärtskompatibel machen',
  projectId: 'p-1',
  projectSlug: 'vorschicht',
  state: 'needs_decision',
  priority: 'P1',
  department: 'Entwicklung',
  type: 'dev',
  branch: 'vorschicht/task-1',
  createdAt: iso(240),
  updatedAt: iso(37),
  retryCount: 1,
};

const SPUREN_LISTE = {
  aufgaben: [
    AUFGABE_ZEILE,
    {
      ...AUFGABE_ZEILE,
      id: AUFGABE_2_ID,
      title: 'Rollback auf dem Host prüfen',
      state: 'coding',
      priority: 'P0',
      branch: 'vorschicht/task-2',
      updatedAt: iso(8),
      retryCount: 0,
    },
    {
      ...AUFGABE_ZEILE,
      id: AUFGABE_3_ID,
      title: 'Lizenzprüfung für Example App einrichten',
      projectSlug: 'example-app',
      state: 'queued',
      priority: 'P2',
      branch: null,
      updatedAt: iso(120),
      retryCount: 0,
    },
  ],
  truncated: false,
  projekte: [
    { id: 'p-1', slug: 'vorschicht', name: 'Vorschicht' },
    { id: 'p-2', slug: 'example-app', name: 'Example App' },
  ],
};

const LAUF = {
  runId: LAUF_ID,
  taskId: AUFGABE_ID,
  role: 'db-review',
  model: 'opus-class',
  backend: 'headless',
  cwd: '/data/worktrees/vorschicht/task-1',
  sessionId: '8f3a1c7e-2b44-4d19-9a05-1c0de7b6f210',
  createdAt: iso(45),
  startedAt: iso(45),
  endedAt: iso(37),
  durationMs: 476_000,
  finished: true,
  terminalReason: 'completed',
  exitCode: 0,
  tokensIn: 200,
  tokensOut: 4118,
  costUsd: 1.42,
  toolUses: 14,
  hookEvents: 14,
  permissionDenials: 0,
  caps: { maxTurns: 40, maxBudgetUsd: 16, wallClockMs: 5_400_000 },
  repairOf: null,
  resumedOf: null,
  transcriptPath: '/data/transcripts/2026-08-12/lauf-1.jsonl',
  transcriptProblem: null,
};

const AUFGABE_DETAIL = {
  aufgabe: {
    aufgabe: AUFGABE_ZEILE,
    description:
      'Die Migration entfernt `legacy_state`. Nach §12/A24 muss sie mit dem vorigen Release ' +
      'lesbar bleiben, weil ein Rollback nur den Code wiederherstellt.',
    acceptanceCriteria: [
      'Die Migration ist mit dem vorigen Release lesbar.',
      'Die Rückwärtsmigration ist geschrieben und läuft.',
      'Der Migrations-Review antwortet `backwardCompatible: true`.',
    ],
    worktreePath: '/data/worktrees/vorschicht/task-1',
    ereignisse: [
      {
        seq: 1,
        kind: 'created',
        occurredAt: iso(240),
        state: 'queued',
        priority: 'P1',
        actor: 'product',
        payload: { title: AUFGABE_ZEILE.title, priority: 'P1' },
      },
      {
        seq: 2,
        kind: 'state_changed',
        occurredAt: iso(230),
        state: 'planning',
        priority: 'P1',
        actor: 'scheduler',
        payload: { runId: LAUF_0_ID, from: 'queued' },
      },
      {
        seq: 3,
        kind: 'state_changed',
        occurredAt: iso(120),
        state: 'coding',
        priority: 'P1',
        actor: 'scheduler',
        payload: { runId: LAUF_0_ID },
      },
      {
        seq: 4,
        kind: 'escalation_requested',
        occurredAt: iso(37),
        state: 'needs_decision',
        priority: 'P1',
        actor: 'db-review',
        payload: {
          runId: LAUF_ID,
          number: 42,
          question: KARTE.question,
          backwardCompatible: false,
        },
      },
    ],
    laeufe: [LAUF],
    gateLaeufe: [
      {
        id: 'g-1',
        stage: 'merge_queue',
        startedAt: iso(60),
        finishedAt: iso(58),
        durationMs: 121_000,
        ok: false,
        headSha: '9f3c1a7e2b444d199a051c0de7b6f210aaaaaaaa',
        baseRef: 'main',
        steps: [
          {
            id: 'typecheck',
            verdict: 'ok',
            detail: null,
            output: null,
            exitCode: 0,
            durationMs: 8100,
            attempts: 1,
          },
          {
            id: 'migration-review',
            verdict: 'finding',
            detail: 'Nicht rückwärtskompatibel: `DROP COLUMN legacy_state`.',
            output:
              'packages/db/migrations/0023_drop_legacy_state.sql:3\n' +
              '  ALTER TABLE tasks DROP COLUMN legacy_state;\n' +
              '  ^ das vorige Release liest diese Spalte in apps/orchestrator/src/tasks.ts:88',
            exitCode: 1,
            durationMs: 94_000,
            attempts: 1,
          },
        ],
      },
    ],
    befunde: [
      {
        id: 'b-1',
        gateRunId: 'g-1',
        gateId: 'migration-review',
        raisedAt: iso(58),
        raisedOnSha: '9f3c1a7e2b444d199a051c0de7b6f210aaaaaaaa',
        detail: 'Nicht rückwärtskompatibel: `DROP COLUMN legacy_state`.',
        output: null,
        exitCode: 1,
        severity: 'blocker',
        status: 'open',
        resolvedAt: null,
        resolvedOnSha: null,
      },
    ],
  },
};

/**
 * Das Sitzungsprotokoll — und der Grund, warum in Zeile 3 fremder Text mit
 * spitzen Klammern steht: er muss als **Text** ankommen. Die Browserstrecke
 * prüft das gegen die echte API (`spuren.spec.ts`), das Bild zeigt es.
 */
const TRANSKRIPT_ZEILEN = [
  {
    nr: 1,
    kind: 'system',
    titel: 'Sitzungsstart · db-review',
    text: '{"type":"system","subtype":"init","model":"opus-class","tools":["Read","Grep","Glob"]}',
    truncated: false,
    marks: [],
  },
  {
    nr: 2,
    kind: 'assistant',
    titel: 'Antwort der Sitzung',
    text:
      'Ich lese zuerst die Migration selbst und danach jede Stelle, an der das vorige Release\n' +
      '`legacy_state` liest. Der Befund hängt an der zweiten Hälfte: eine entfernte Spalte ist\n' +
      'nur dann rückwärtskompatibel, wenn niemand sie mehr liest.',
    truncated: false,
    marks: [],
  },
  {
    nr: 3,
    kind: 'tool_use',
    titel: 'Read · packages/db/migrations/0023_drop_legacy_state.sql',
    text:
      '-- 0023: legacy_state entfernen\n' +
      '-- FIXME laut Kommentar der vorigen Sitzung: <img src=x onerror="alert(1)"> — steht so\n' +
      '-- in der Datei und muss hier als Text ankommen, nicht als Markup.\n' +
      'ALTER TABLE tasks DROP COLUMN legacy_state;',
    truncated: false,
    marks: [],
  },
  {
    nr: 4,
    kind: 'tool_use',
    titel: 'mcp__vorschicht__escalate_ask',
    text: JSON.stringify(
      {
        question: KARTE.question,
        urgency: 'P1',
        options: KARTE.options.map((o) => ({ title: o.title, recommended: o.recommended })),
      },
      null,
      2,
    ),
    truncated: false,
    marks: ['decision'],
  },
  {
    nr: 5,
    kind: 'result',
    titel: 'Ergebnis · needs_decision',
    text: '{"status":"needs_decision","summary":"Migration ist nicht rückwärtskompatibel."}',
    truncated: false,
    marks: [],
  },
];

const LAUF_DETAIL = {
  lauf: {
    lauf: LAUF,
    aufgabe: AUFGABE_ZEILE,
    transkript: {
      state: 'present',
      erklaerung: '',
      compressed: false,
      path: LAUF.transcriptPath,
      totalLines: 5,
      page: 1,
      pages: 1,
      pageSize: 200,
      lines: TRANSKRIPT_ZEILEN,
      marks: [{ nr: 4, kind: 'decision', titel: 'mcp__vorschicht__escalate_ask' }],
      focus: 4,
      focusProblem: null,
    },
  },
};

// ---------------------------------------------------------------------------
// Der Server
// ---------------------------------------------------------------------------

/** Was die Dokumentensuche gerade antwortet; ein Szenario setzt es. */
let suchtreffer = { dokumente: [], nochNichtDurchsuchbar: 1 };

function json(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function starteServer() {
  const server = createServer(async (req, res) => {
    const pfad = (req.url ?? '/').split('?')[0];

    if (pfad === '/api/auth/state') {
      return json(res, {
        bootstrap: { complete: true, credentialCount: 2, missing: 0 },
        hinweis: null,
        angemeldet: true,
      });
    }
    if (pfad === '/api/me') return json(res, { credentialId: 'max' });

    if (pfad === '/api/posteingang') return json(res, { posteingang: [ZWEITE_KARTE, KARTE] });
    if (pfad.startsWith('/api/posteingang/')) return json(res, { eskalation: KARTE });
    if (pfad === '/api/entscheidungen') return json(res, { entscheidungen: ENTSCHEIDUNGEN });

    if (pfad === '/api/controlling') return json(res, CONTROLLING);
    if (pfad === '/api/einstellungen/personas') return json(res, PERSONAS);
    if (pfad === '/api/projekte') return json(res, PROJEKTE);

    if (pfad === '/api/dokumente/suche') return json(res, suchtreffer);
    if (pfad.startsWith('/api/dokumente/')) {
      // §13s dritter Zustand braucht ein eigenes Dokument: „abgelegt, aber
      // niemand hat es gelesen" ist über die **Suche** gar nicht erreichbar —
      // eine Datei ohne ausgelesenen Text kann auf keine Suche passen, das ist
      // der ganze Punkt. Also zeigt ihn die Einzelansicht.
      const pdf = pfad.includes(DOKUMENT_PDF.id);
      return json(res, {
        dokument: pdf
          ? { document: DOKUMENT_PDF, versions: [FASSUNG_PDF] }
          : { document: DOKUMENT_TEXT, versions: [FASSUNG_TEXT] },
      });
    }

    if (pfad === '/api/quellen') return json(res, { quellen: [QUELLE, QUELLE_VORSCHLAG] });
    if (pfad.startsWith('/api/quellen/')) return json(res, QUELLE_DETAIL);

    if (pfad === '/api/aufgaben') return json(res, SPUREN_LISTE);
    if (pfad.startsWith('/api/aufgaben/')) return json(res, AUFGABE_DETAIL);
    if (pfad.startsWith('/api/laeufe/')) return json(res, LAUF_DETAIL);

    // Offen halten, sonst flackert die Verbindungsanzeige der Hülle.
    if (pfad === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': offen\n\n');
      return;
    }

    const kandidat = join(DIST, pfad === '/' ? 'index.html' : pfad.slice(1));
    const datei = existsSync(kandidat) && extname(kandidat) ? kandidat : join(DIST, 'index.html');
    try {
      const inhalt = await readFile(datei);
      res.writeHead(200, { 'content-type': MIME[extname(datei)] ?? 'application/octet-stream' });
      res.end(inhalt);
    } catch {
      res.writeHead(404).end('nicht gefunden');
    }
  });

  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

// ---------------------------------------------------------------------------
// Die Szenarien
// ---------------------------------------------------------------------------

/**
 * Je Seite ein Bild, und `warteAuf` ist die Zusicherung darin: es ist immer ein
 * Kennzeichen des **gelungenen** Zustands, nie der Seitenrahmen. Zeichnet eine
 * Seite ihren Fehler- oder Ladezustand — etwa weil eine Nutzlast nicht mehr zum
 * Vertrag passt —, läuft das Warten in die Zeitgrenze und der Lauf meldet es,
 * statt ein Bild vom Fehlersatz abzulegen.
 */
const SEITEN = [
  { name: 'auth', pfad: '/', warteAuf: '[data-testid="login"]', abgemeldet: true },
  { name: 'projekte', pfad: '/projekte', warteAuf: '[data-testid="projektliste"]' },
  {
    name: 'projekt-einstellungen',
    pfad: '/projekte/vorschicht',
    warteAuf: '[data-testid="releaseliste"]',
  },
  { name: 'posteingang', pfad: '/posteingang', warteAuf: '[data-testid="posteingang-liste"]' },
  {
    name: 'entscheidungen',
    pfad: '/entscheidungen',
    warteAuf: '[data-testid="entscheidungsliste"]',
  },
  { name: 'dokumente', pfad: '/dokumente', warteAuf: '[data-testid="ablegezone"]' },
  {
    name: 'dokumente-treffer',
    pfad: '/dokumente',
    warteAuf: '[data-testid="dokumentenliste"]',
    vorher: async (seite) => {
      suchtreffer = {
        dokumente: [
          {
            document: DOKUMENT_TEXT,
            versionId: FASSUNG_TEXT.id,
            version: 1,
            rank: 0.41,
            departmentMatch: true,
            score: 0.49,
          },
        ],
        nochNichtDurchsuchbar: 1,
      };
      await seite.getByTestId('dokumente-suche').fill('Kündigung');
      await seite.getByTestId('dokumente-suchen').click();
    },
  },
  {
    name: 'dokument',
    pfad: `/dokumente/${DOKUMENT_TEXT.id}`,
    warteAuf: '[data-testid="versionsliste"]',
  },
  {
    // Die andere Hälfte: abgelegt und **nicht** ausgelesen. Sie muss anders
    // aussehen als „durchsuchbar", sonst ist die Unterscheidung nur ein Satz.
    name: 'dokument-ungelesen',
    pfad: `/dokumente/${DOKUMENT_PDF.id}`,
    warteAuf: '[data-testid="versionsliste"]',
  },
  { name: 'quellen', pfad: '/quellen', warteAuf: '[data-testid="quellenliste"]' },
  { name: 'quelle', pfad: `/quellen/${QUELLE.id}`, warteAuf: '[data-testid="verlauf"]' },
  { name: 'controlling', pfad: '/controlling', warteAuf: '[data-testid="controlling-fenster"]' },
  { name: 'einstellungen', pfad: '/einstellungen', warteAuf: '[data-testid="persona-liste"]' },
  { name: 'aufgaben', pfad: '/aufgaben', warteAuf: '[data-testid="spuren-tabelle"]' },
  { name: 'aufgabe', pfad: `/aufgaben/${AUFGABE_ID}`, warteAuf: '[data-testid="zeitstrahl"]' },
  {
    name: 'sitzungsprotokoll',
    pfad: `/laeufe/${LAUF_ID}?marke=decision`,
    warteAuf: '[data-testid="transkript-zeile-fokus"]',
  },
];

const BREITEN = [
  { schlage: 'schreibtisch', breite: 1280, hoehe: 900 },
  { schlage: 'handy', breite: 390, hoehe: 844 },
];

async function main() {
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error('Kein gebautes Bundle — baue apps/web …');
    const gebaut = spawnSync('pnpm', ['--filter', '@vorschicht/web', 'build'], {
      cwd: WURZEL,
      stdio: 'inherit',
    });
    if (gebaut.status !== 0 || !existsSync(join(DIST, 'index.html'))) {
      console.error('Bundle liess sich nicht bauen. Nichts geprüft (A25).');
      process.exit(2);
    }
  }

  let chromium;
  try {
    ({ chromium } = await import('@playwright/test'));
  } catch {
    console.error('Playwright fehlt. Nichts geprüft (A25).');
    process.exit(2);
  }

  await mkdir(ZIEL, { recursive: true });
  const server = await starteServer();
  const port = server.address().port;
  let browser;
  try {
    browser = await chromium.launch();
  } catch (grund) {
    server.close();
    console.error(`Kein Browser: ${grund.message}. Nichts geprüft (A25).`);
    process.exit(2);
  }

  let fehler = 0;
  let bilder = 0;
  try {
    for (const seite of SEITEN) {
      for (const format of BREITEN) {
        const datei = `seite-${seite.name}-${format.schlage}.png`;
        const tab = await browser.newPage({
          viewport: { width: format.breite, height: format.hoehe },
          deviceScaleFactor: 2,
        });
        try {
          // Abgemeldet: die Hülle zeigt dann Begrüßung und Zugang statt der
          // Navigation — das ist die Ansicht, die ein eingeladener Mensch sieht.
          if (seite.abgemeldet) {
            await tab.route('**/api/auth/state', (route) =>
              route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                  bootstrap: { complete: false, credentialCount: 1, missing: 1 },
                  hinweis:
                    'Die Einrichtung ist noch nicht vollständig: es fehlt noch ein zweites Gerät.',
                  angemeldet: false,
                }),
              }),
            );
          }
          await tab.goto(`http://127.0.0.1:${port}${seite.pfad}`, { waitUntil: 'load' });
          if (seite.vorher) await seite.vorher(tab);
          await tab.waitForSelector(seite.warteAuf, { timeout: 15_000 });
          // Den Zeiger von allem wegnehmen, was er gerade berührt: nach einem
          // Klick steht er auf dem Knopf, und das Bild zeigte dann dessen
          // Hover-Zustand als wäre es der Ruhezustand.
          await tab.mouse.move(0, 0);
          await tab.screenshot({ path: join(ZIEL, datei), fullPage: true });

          // Was ein Bild nicht zeigt: ob die Seite dafür seitlich rollen muss.
          // Auf 390 px ist das die Zusicherung, an der eine Gestaltung scheitert
          // — eine einzige lange Kennung reicht dafür aus.
          const quer = await tab.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          );
          if (quer) {
            fehler += 1;
            // Nicht nur melden **dass** sie überläuft: welches Element es tut,
            // ist die einzige Angabe, mit der jemand etwas anfangen kann.
            const schuldige = await tab.evaluate(() => {
              const grenze = document.documentElement.clientWidth;
              const raus = [];
              for (const el of document.querySelectorAll('*')) {
                const r = el.getBoundingClientRect();
                if (r.right > grenze + 1) {
                  raus.push(
                    `${el.tagName.toLowerCase()}` +
                      `${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}` +
                      `${el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : ''}` +
                      ` bis ${Math.round(r.right)}px`,
                  );
                }
              }
              return raus.slice(0, 6);
            });
            console.error(`  ✗ ${datei} — die Seite läuft waagrecht über.`);
            for (const zeile of schuldige) console.error(`      ${zeile}`);
          } else {
            bilder += 1;
            console.log(`  ✓ ${datei}`);
          }
        } catch (grund) {
          fehler += 1;
          console.error(`  ✗ ${datei} — ${grund.message.split('\n')[0]}`);
        } finally {
          await tab.close();
        }
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${bilder} Bilder in docs/media/, ${fehler} Fehler.`);
  process.exit(fehler === 0 ? 0 : 1);
}

await main();
