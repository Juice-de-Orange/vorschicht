#!/usr/bin/env node
/**
 * §22 P9.G1: „≥ 2 consecutive weeks of operation with **zero uncontrolled limit
 * events** (never reached 100% on any window; every threshold crossing handled
 * by the guardian as specified)".
 *
 *   node infra/scripts/check-budgetfenster.mjs [--von <ISO>] [--bis <ISO>] [--wochen 2]
 *   infra/scripts/budgetfenster-remote.sh --host <ssh-host>
 *
 * ## Vier Zusicherungen, und die erste ist der ganze Grund
 *
 * **1. `estimated` und `official` sind zwei Auswertungen, nicht eine.** Die
 * Codebasis sagt selbst warum:
 *
 *   - Die **Schwellen sind verschieden**: official 85/95, estimated **75**
 *     (`DEGRADED_WRAP_UP_PERCENT`), und `evaluateGuardian` wählt sie je Probe.
 *     Wer 85 auf eine Schätzung anlegt, meldet jede Überschreitung zwischen 75
 *     und 85 als „nicht behandelt". Wer 75 auf eine offizielle Messung anlegt,
 *     erfindet Überschreitungen.
 *   - Die **Bedeutung von 100 ist verschieden**. `official = 100` ist ein
 *     Limitereignis. `estimated = 100` ist nach A101 in diesem Haus zuerst ein
 *     Verdacht **gegen den Zähler**: dort standen 1.454 solche Zeilen, während
 *     tatsächlich nur wenige USD-Äquivalent (Beispielwert des Vorfalls: 3,53) ausgegeben waren, weil eine
 *     Anbieter-*Warnung* als Ablehnung gelesen wurde und das Wochenbudget von
 *     1120 auf 3 stürzte. Beide sind Befunde; sie sind **nicht derselbe Satz**,
 *     und dieses Skript sagt welcher.
 *
 * **2. Unbekannte Ankerstatus werden nicht klassifiziert.** `status` ist freier
 * Text. A101.1 ist genau daran passiert: `<> 'allowed'` machte jeden unbekannten
 * Status zur Ablehnung, einschliesslich des Literals `'unbekannt'`, das
 * `headless.ts` für eine unbekannte Rahmenform schreibt. Hier gibt es eine
 * **Positivliste**; alles andere macht den Tag „nicht beurteilbar" und bricht
 * die Strecke, statt einen Befund zu erfinden oder eine Entwarnung zu geben.
 *
 * **3. Jede Schwellenüberschreitung wird mit der Reaktion gepaart — und die
 * Gegenrichtung ist die, die man weglässt.** Jede `guardian_events`-Zeile mit
 * `reason.kind = 'threshold'` braucht eine Messung, die sie rechtfertigt. A101
 * war ein **Phantom-Stopp**: sieben Tage `hard_stop` ohne Anlass. Eine Prüfung,
 * die nur „jede Überschreitung hat eine Reaktion" prüft, hätte ihn durchgewunken.
 *
 * **4. „≥ 2 aufeinanderfolgende Wochen *of operation*" wird nicht trivial
 * erfüllt.** Das ist `check-kennzahlen.mjs`s Buchführung auf eine Zeitachse
 * übertragen: ein Tag zählt nur als Betriebstag, wenn es an ihm Belege für
 * Betrieb gibt. Ohne das meldet ein zwei Wochen abgeschalteter Daemon null
 * unkontrollierte Ereignisse und liest sich wie ein bestandenes Gate.
 *
 * ## Prüfgrenzen (stehen in der Ausgabe jedes Laufs, A119.3)
 *
 * Exit: 0 eingehalten · 1 Befund · 2 nichts geprüft (A25/A50).
 */
import { dirname, join } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

// Wie die Nachbarn: über `pathToFileURL`, nie über einen nackten Pfad (A130) —
// und über die gebauten Pakete statt über `postgres` direkt, weil dieses
// Verzeichnis kein eigenes `node_modules` hat.
const { createSql } = await import(
  pathToFileURL(join(REPO_ROOT, 'packages/db/dist/index.js')).href
);

const BEKANNTE_ANKERSTATUS = {
  erlaubt: ['allowed', 'allowed_warning'],
  abgelehnt: ['rejected', 'refused', 'blocked'],
};

/** §7.2s Zahlen, importiert **und** gegen die Spezifikation gehalten. */
const SPEC = { wrapUp: 85, hardStop: 95, geschaetztWrapUp: 75 };

function argument(name, vorgabe = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : vorgabe;
}

const url = env.DATABASE_URL ?? env.TEST_DATABASE_URL;
if (!url) {
  console.error('check-budgetfenster: kein DATABASE_URL — nichts geprüft (A25).');
  exit(2);
}

const wochen = Number(argument('--wochen', '2'));
const bis = argument('--bis') ? new Date(argument('--bis')) : new Date();
const von = argument('--von')
  ? new Date(argument('--von'))
  : new Date(bis.getTime() - wochen * 7 * 24 * 60 * 60_000);

if (Number.isNaN(von.getTime()) || Number.isNaN(bis.getTime()) || von >= bis) {
  console.error('check-budgetfenster: unbrauchbarer Zeitraum — nichts geprüft (A25).');
  exit(2);
}

const sql = createSql({ url, max: 2 });
let befunde = 0;
const gruen = (t) => console.log(`  \x1b[32m✓\x1b[0m ${t}`);
const befund = (t) => {
  console.log(`  \x1b[31m✗\x1b[0m ${t}`);
  befunde += 1;
};
const hinweis = (t) => console.log(`  \x1b[2m…\x1b[0m ${t}`);
const kopf = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

try {
  const tag = (d) => new Date(d).toISOString().slice(0, 10);

  // --- Schwellen gegen die Spezifikation ------------------------------------
  // Erbt keinen falschen Konstantenwert und läuft der Spezifikation auch nicht
  // davon: die Zahlen stehen hier ausgeschrieben und werden verglichen.
  const { GUARDIAN_THRESHOLDS, DEGRADED_WRAP_UP_PERCENT } = await import(
    pathToFileURL(join(REPO_ROOT, 'packages/shared/dist/constants.js')).href
  );
  kopf('Schwellen (§7.2)');
  const istWrap = GUARDIAN_THRESHOLDS.WRAP_UP_PERCENT;
  const istHard = GUARDIAN_THRESHOLDS.HARD_STOP_PERCENT;
  if (
    istWrap !== SPEC.wrapUp ||
    istHard !== SPEC.hardStop ||
    DEGRADED_WRAP_UP_PERCENT !== SPEC.geschaetztWrapUp
  ) {
    befund(
      `Der Code sagt ${istWrap}/${istHard} (offiziell) und ${DEGRADED_WRAP_UP_PERCENT} (geschätzt), ` +
        `§7.2 sagt ${SPEC.wrapUp}/${SPEC.hardStop} und ${SPEC.geschaetztWrapUp}.`,
    );
  } else {
    gruen(`offiziell ${istWrap} / ${istHard}, geschätzt ${DEGRADED_WRAP_UP_PERCENT} — wie §7.2`);
  }

  // --- Betriebstage ----------------------------------------------------------
  kopf(`Betriebstage im Fenster ${tag(von)} bis ${tag(bis)}`);
  const laeufe = await sql`
    SELECT to_char(occurred_at, 'YYYY-MM-DD') AS tag, count(*)::int AS n
    FROM agent_run_events
    WHERE kind = 'result' AND occurred_at >= ${von} AND occurred_at < ${bis}
    GROUP BY 1
  `;
  const proben = await sql`
    SELECT to_char(observed_at, 'YYYY-MM-DD') AS tag, count(*)::int AS n
    FROM usage_samples
    WHERE observed_at >= ${von} AND observed_at < ${bis}
    GROUP BY 1
  `;
  const mitLauf = new Set(laeufe.map((r) => r.tag));
  const mitProbe = new Set(proben.map((r) => r.tag));

  const tage = [];
  for (let t = new Date(von); t < bis; t = new Date(t.getTime() + 24 * 60 * 60_000)) {
    tage.push(tag(t));
  }
  const streifen = tage.map((d) => (mitLauf.has(d) ? 'B' : mitProbe.has(d) ? '·' : '_')).join('');
  console.log(`  ${streifen}`);
  hinweis('B = Betrieb (eine Sitzung lieferte ein Ergebnis) · · = nur gemessen · _ = still');

  let laengste = 0;
  let lauf = 0;
  for (const d of tage) {
    if (mitLauf.has(d)) {
      lauf += 1;
      laengste = Math.max(laengste, lauf);
    } else lauf = 0;
  }
  if (laengste < 14) {
    befund(`Längste zusammenhängende Betriebsstrecke: ${laengste} Tag(e) — §22 verlangt 14.`);
  } else {
    gruen(`Längste zusammenhängende Betriebsstrecke: ${laengste} Tage`);
  }

  // --- Nie 100 %, getrennt nach Quelle ---------------------------------------
  kopf('Auslastung, nach Quelle getrennt');
  const spitzen = await sql`
    SELECT source, window_kind, max(used_percent)::float8 AS spitze, count(*)::int AS n
    FROM usage_samples
    WHERE observed_at >= ${von} AND observed_at < ${bis}
    GROUP BY 1, 2 ORDER BY 1, 2
  `;
  if (spitzen.length === 0) {
    hinweis('Keine einzige Messung im Fenster — über die Auslastung sagt dieser Lauf nichts.');
  }
  for (const z of spitzen) {
    const grenze = z.source === 'official' ? SPEC.hardStop : SPEC.geschaetztWrapUp;
    const text = `${z.source} / ${z.window_kind}: Spitze ${z.spitze.toFixed(2)} % (${z.n} Messungen)`;
    if (z.spitze >= 100 && z.source === 'official') {
      befund(`${text} — **100 % offiziell erreicht.** Das ist ein Limitereignis (§22 P9.G1).`);
    } else if (z.spitze >= 100) {
      befund(
        `${text} — 100 % **geschätzt**. Nach A101 ist das zuerst ein Verdacht gegen den Zähler, ` +
          'nicht gegen das Konto: dort stand dieselbe Zahl bei wenigen USD-Äquivalent tatsächlicher Ausgaben (Beispielwert des Vorfalls: 3,53).',
      );
    } else if (z.spitze >= grenze) {
      gruen(`${text} — über der Schwelle ${grenze}, aber unter 100`);
    } else {
      gruen(text);
    }
  }

  // --- Anker: die harte Evidenz ----------------------------------------------
  kopf('Ankerzeilen des Anbieters');
  const anker = await sql`
    SELECT status, window_kind, count(*)::int AS n, max(observed_at) AS zuletzt
    FROM usage_window_anchors
    WHERE observed_at >= ${von} AND observed_at < ${bis}
    GROUP BY 1, 2 ORDER BY 1, 2
  `;
  if (anker.length === 0) hinweis('Keine Ankerzeile im Fenster.');
  let unbekannt = 0;
  for (const a of anker) {
    const zeile = `${a.status} / ${a.window_kind}: ${a.n}× (zuletzt ${tag(a.zuletzt)})`;
    if (BEKANNTE_ANKERSTATUS.abgelehnt.includes(a.status)) {
      befund(`${zeile} — **das Konto hat abgelehnt.** Das ist ein Limitereignis.`);
    } else if (BEKANNTE_ANKERSTATUS.erlaubt.includes(a.status)) {
      gruen(zeile);
    } else {
      unbekannt += 1;
      befund(
        `${zeile} — **unbekannter Status.** Er wird weder als Ablehnung noch als Entwarnung ` +
          'gewertet (A101.1: `<> allowed` machte einmal jeden unbekannten Status zur Ablehnung). ' +
          'Der Zeitraum ist damit nicht beurteilbar.',
      );
    }
  }

  // --- Überschreitungen und ihre Reaktion (die primäre Richtung) -------------
  //
  // **Der Wächter schreibt nur bei Zustandswechsel.** Eine zweite
  // Überschreitung im selben Latch ist deshalb behandelt, wenn zum Zeitpunkt
  // der Überschreitung bereits ein Zustand ≥ dem erwarteten stand — ohne diese
  // Regel meldet jeder Lauf rot. Gemessen an den Betriebsdaten vom 25.8.2026:
  // am 12.8. um 16:12 kam eine offizielle 85 %, und der Wächter stand seit dem
  // 9.8. auf `hard_stop`. Kein Wechsel fällig, kein Befund.
  kopf('Schwellenüberschreitungen und ihre Behandlung');
  const alleZustaende = await sql`
    SELECT occurred_at, state FROM guardian_events ORDER BY occurred_at
  `;
  const zustandBei = (t) => {
    let letzter = 'normal';
    for (const z of alleZustaende) {
      if (new Date(z.occurred_at) <= new Date(t)) letzter = z.state;
      else break;
    }
    return letzter;
  };
  const rang = { normal: 0, wrap_up: 1, hard_stop: 2 };

  const messungen = await sql`
    SELECT observed_at, source, window_kind, used_percent::float8 AS pct
    FROM usage_samples
    WHERE observed_at >= ${von} AND observed_at < ${bis}
    ORDER BY source, window_kind, observed_at
  `;
  const schwelleFuer = (quelle, prozent) => {
    const wrap = quelle === 'official' ? SPEC.wrapUp : SPEC.geschaetztWrapUp;
    if (prozent >= SPEC.hardStop) return { erwartet: 'hard_stop', grenze: SPEC.hardStop };
    if (prozent >= wrap) return { erwartet: 'wrap_up', grenze: wrap };
    return null;
  };

  let ueberschreitungen = 0;
  let unbehandelt = 0;
  const vorher = new Map();
  for (const m of messungen) {
    const schluessel = `${m.source}:${m.window_kind}`;
    const zuvor = vorher.get(schluessel) ?? null;
    const jetzt = schwelleFuer(m.source, m.pct);
    const davor = zuvor === null ? null : schwelleFuer(m.source, zuvor);
    vorher.set(schluessel, m.pct);
    // Eine **Überschreitung** ist der Übergang in ein höheres Band, nicht jede
    // Messung darüber — sonst zählt eine ruhige Woche über der Schwelle
    // tausendfach.
    if (!jetzt) continue;
    if (davor && rang[davor.erwartet] >= rang[jetzt.erwartet]) continue;
    ueberschreitungen += 1;
    const stand = zustandBei(m.observed_at);
    if (rang[stand] >= rang[jetzt.erwartet]) {
      gruen(
        `${tag(m.observed_at)} ${schluessel} auf ${m.pct.toFixed(2)} % — der Wächter stand ` +
          `bereits auf ${stand} (≥ ${jetzt.erwartet}), kein Wechsel fällig`,
      );
      continue;
    }
    const [reaktion] = await sql`
      SELECT occurred_at, state FROM guardian_events
      WHERE occurred_at >= ${m.observed_at}
        AND occurred_at <= ${new Date(new Date(m.observed_at).getTime() + 30 * 60_000)}
      ORDER BY occurred_at LIMIT 1
    `;
    if (reaktion && rang[reaktion.state] >= rang[jetzt.erwartet]) {
      gruen(
        `${tag(m.observed_at)} ${schluessel} auf ${m.pct.toFixed(2)} % → ${reaktion.state}, ` +
          'wie §7.2 es vorsieht',
      );
    } else {
      unbehandelt += 1;
      befund(
        `${tag(m.observed_at)} ${schluessel} auf ${m.pct.toFixed(2)} % (≥ ${jetzt.grenze}) — ` +
          `erwartet wäre ${jetzt.erwartet}, der Wächter stand auf ${stand} und wechselte ` +
          `${reaktion ? `nach ${reaktion.state}` : 'gar nicht'}.`,
      );
    }
  }
  if (ueberschreitungen === 0) {
    hinweis('Keine Schwellenüberschreitung im Fenster — dann prüft diese Hälfte nichts.');
  } else {
    hinweis(`${ueberschreitungen} Überschreitung(en) geprüft, ${unbehandelt} unbehandelt.`);
  }

  // --- Wächterzeilen in beide Richtungen -------------------------------------
  kopf('Wächterzustände und ihre Anlässe');
  const zustaende = await sql`
    SELECT occurred_at, state, reason, governing_window
    FROM guardian_events
    WHERE occurred_at >= ${von} AND occurred_at < ${bis}
    ORDER BY occurred_at
  `;
  if (zustaende.length === 0) {
    hinweis('Kein Zustandswechsel im Fenster — der Wächter stand durchgehend auf demselben Wert.');
  }
  for (const z of zustaende) {
    const art = z.reason?.kind ?? '(ohne Grund)';
    if (art !== 'threshold') {
      gruen(`${tag(z.occurred_at)} → ${z.state} (${art})`);
      continue;
    }
    // Die Gegenrichtung: gab es eine Messung, die diesen Stopp rechtfertigt?
    const fenster = z.governing_window ?? null;
    const [beleg] = await sql`
      SELECT max(used_percent)::float8 AS spitze
      FROM usage_samples
      WHERE observed_at <= ${z.occurred_at}
        AND observed_at > ${new Date(new Date(z.occurred_at).getTime() - 30 * 60_000)}
        ${fenster ? sql`AND window_kind = ${fenster}` : sql``}
    `;
    const spitze = beleg?.spitze ?? null;
    const erwartet = z.state === 'hard_stop' ? SPEC.hardStop : SPEC.geschaetztWrapUp;
    if (spitze === null) {
      befund(
        `${tag(z.occurred_at)} → ${z.state} (threshold), aber in der halben Stunde davor gibt es ` +
          '**keine Messung**, die ihn rechtfertigt — das ist A101s Phantom-Stopp.',
      );
    } else if (spitze < erwartet) {
      befund(
        `${tag(z.occurred_at)} → ${z.state} (threshold) bei einer Spitze von ${spitze.toFixed(2)} %, ` +
          `erwartet wären ≥ ${erwartet}.`,
      );
    } else {
      gruen(`${tag(z.occurred_at)} → ${z.state} bei ${spitze.toFixed(2)} % — wie §7.2 es vorsieht`);
    }
  }

  // --- Prüfgrenzen ------------------------------------------------------------
  kopf('Prüfgrenzen dieses Laufs');
  console.log(
    [
      '  · Offizielle Messungen gibt es nach A73 nur oberhalb von 75 % — über das',
      '    leise Band darunter sagt dieser Lauf nichts.',
      '  · des Betreibers eigene Nutzung desselben Abos ist für diesen Zähler unsichtbar',
      '    (A60.6). „Nie 100 % erreicht" ist eine Aussage über die von Vorschicht',
      '    gesehene Auslastung, nicht über das Konto.',
      `  · ${ueberschreitungen} Überschreitung(en) im Fenster; ohne eine ist die erste`,
      '    Hälfte des Gate-Satzes ungeprüft, nicht erfüllt.',
      '  · Toleranz 30 Minuten, in beide Richtungen verschieden gemeint: eine',
      '    Überschreitung sucht ihre Reaktion in den 30 Minuten **danach**, eine',
      '    Wächterzeile ihren Anlass in den 30 Minuten **davor**. Die Zahl steht',
      '    hier, damit sie diskutierbar ist statt vergraben.',
      '  · War der Daemon unten, fehlen Messungen **und** Wächterzeilen gemeinsam —',
      '    das sieht aus wie Ruhe. Deshalb die Betriebstage oben.',
      unbekannt > 0
        ? `  · ${unbekannt} unbekannte(r) Ankerstatus: der Zeitraum ist nicht vollständig beurteilbar.`
        : '  · Alle Ankerstatus im Fenster waren bekannt.',
    ].join('\n'),
  );

  console.log(
    befunde > 0
      ? `\n\x1b[1mErgebnis:\x1b[0m ${befunde} Befund(e).`
      : '\n\x1b[1mErgebnis:\x1b[0m keine unkontrollierten Limit-Ereignisse im Fenster.',
  );
  await sql.end();
  exit(befunde > 0 ? 1 : 0);
} catch (fehler) {
  console.error(
    `check-budgetfenster: ${fehler instanceof Error ? fehler.message : String(fehler)}`,
  );
  await sql.end().catch(() => undefined);
  exit(2);
}
