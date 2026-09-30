#!/usr/bin/env bash
# Die laufende Bilanz von Phase 9 (§22).
#
#   bash infra/scripts/demo-phase9.sh
#
# Wie die Nachbarn: **eine Zeile je Gate**, und das Skript setzt **keine Haken
# in `CLAUDE.md`**. Hier steht, was hält; dort steht, was die Phase behauptet.
# Am Anfang der Phase geschrieben und nicht an ihrem Ende, weil es genau dann
# am nützlichsten ist — es trennt, was Arbeit ist, von dem, was Wanduhrzeit ist.
#
# ## Was diese Phase von den acht davor unterscheidet
#
# **Vier der neun Gates sind Uhr, nicht Code.** G1 (zwei Wochen ohne
# unkontrolliertes Limit-Ereignis), G2 (≥ 15 Merges), G3 (roter Pfad im Feld)
# und zur Hälfte G5 verlangen *Betrieb*. Kein Skript kann sie schliessen; es
# kann nur nachweisen, dass es sie **messen** kann. Ihr ehrlicher Zustand ist
# deshalb heute `todo` mit Exit 2 dahinter — nicht rot, weil nichts geprüft nach
# A25/A50 keine Feststellung ist.
#
# **Und ein Gate ist heute unerreichbar, aus einem Grund, der nicht in Phase 9
# steht:** solange A85 Vorschichts eigenes Projekt auf `read_only` hält, ist
# A42s Beitrag zum Boden von ≥ 15 gate-grünen Merges **null**. Das ist der Betreiber'
# Entscheidung und ein audit-protokollierter Aufruf, kein Bauteil.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 2

ON_HOST=0
for arg in "$@"; do
  case "$arg" in
    --on-host) ON_HOST=1 ;;
    *) echo "unbekanntes Argument: $arg" >&2; exit 2 ;;
  esac
done

pass=0; fail=0; deferred=0; open=0
green()    { printf '  \033[32m[x]\033[0m %s\n' "$1"; pass=$((pass+1)); }
red()      { printf '  \033[31m[ ]\033[0m %s\n' "$1"; fail=$((fail+1)); }
defer()    { printf '  \033[33m[~]\033[0m %s\n       → %s\n' "$1" "$2"; deferred=$((deferred+1)); }
todo()     { printf '  \033[34m[ ]\033[0m %s\n       → %s\n' "$1" "$2"; open=$((open+1)); }
headline() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Ein Pfad **je Lauf** (A121.2).
LOG="${TMPDIR:-/tmp}/vorschicht-demo-phase9-$$.log"
: > "$LOG"

printf '\033[1mPhase 9 — Pilotbetrieb und Härtung (§22)\033[0m\n'
printf 'Protokoll: %s\n' "$LOG"

# --- G1 ---------------------------------------------------------------------
headline 'G1 — ≥ 2 Wochen Betrieb ohne unkontrolliertes Limit-Ereignis'
todo 'Uhr, nicht Code — und das Auswertungsskript fehlt noch' \
     '§22 Schritt 2. Zwei Wochen sind Wanduhrzeit und beginnen erst mit dem Pilotbetrieb, also nach dem Betreiber Klon-Entscheidung. Was heute schon gebaut werden kann und noch fehlt, ist `check-budgetfenster.mjs`: es müsste `estimated` und `official` **getrennt** auswerten (verschiedene Schwellen, 75 gegen 85/95) und jede Schwellenüberschreitung mit der Reaktion des Wächters paaren — **und die Gegenrichtung**, denn A101 war ein Phantom-Stopp: sieben Tage `hard_stop` ohne Anlass. Eine Prüfung, die nur „jede Überschreitung hat eine Reaktion" prüft, hätte ihn durchgewunken'

# --- G2 ---------------------------------------------------------------------
headline 'G2 — ≥ 15 echte Aufgaben über die Piloten, alle Gates grün, ausgerollt'
todo 'blockiert: es gibt kein schreibbares Projekt' \
     '§22 Schritt 1–2. A85 hält Vorschichts eigenes Projekt auf `read_only`, der Ablaufplaner überspringt es, und es gibt kein zweites. Der Betreiber hat am 25.8.2026 entschieden: der Boden läuft **allein auf dem Vorschicht-Klon**, und der kommt, sobald Phase 9s Werkzeuge stehen. Bis dahin ist der Beitrag null — nachweisbar am Ereignisprotokoll: keine einzige `merge.*`- oder `deploy.*`-Zeile'

# --- G3 ---------------------------------------------------------------------
headline 'G3 — roter Pfad einmal im Feld, aufgelöst, Spur geprüft'
todo 'Uhr, nicht Code — die Mechanik steht, der Träger fehlt' \
     '§9s roter Pfad ist gebaut und in `dev-chain.itest.ts` bewiesen (zweimal rot → einmal requeued → eskaliert mit Diagnose). Was fehlt, ist ein Projekt, auf dem er im Betrieb eintritt — dasselbe wie bei G2. „Spur geprüft" ist danach Lektüre des Betreibers'

# --- G4 ---------------------------------------------------------------------
headline 'G4 — Wiederherstellungsprobe, gestrige Sicherung samt Transkripten'
if [ "$ON_HOST" -eq 1 ]; then
  if bash infra/scripts/restore-probe.sh >>"$LOG" 2>&1; then
    green "alle sechs Stufen halten — siehe $LOG"
  else
    code=$?
    case "$code" in
      2) todo 'nicht geprüft' "Die Probe kam nicht zustande (keine Sicherung, kein Docker, kein Platz). Nichts geprüft ist nach A25 keine Feststellung. $LOG" ;;
      *) red "die Wiederherstellungsprobe hat einen Befund — siehe $LOG" ;;
    esac
  fi
else
  todo 'das Skript liegt bereit und ist gegen den Produktionshost gelaufen' \
       '§22 Schritt 5. `infra/scripts/restore-probe.sh` prüft sechs Stufen; die tragende ist, dass die Transkripte, auf die `agent_runs` zeigt, im entpackten Archiv wirklich liegen (§1 Grundsatz 4), und die sechste löscht **eine** Datei und erwartet genau eine Fehlstelle. Beim ersten Lauf gegen den Produktionshost hat sie zwei verlorene Sitzungsprotokolle gefunden (A150.6). Hier mit `--on-host`, oder direkt: ssh <ssh-host> sudo /opt/vorschicht/infra/scripts/restore-probe.sh'
fi

# --- G5 ---------------------------------------------------------------------
headline 'G5 — Rollback-Probe auf einem Pilotprojekt unter Produktionsbedingungen'
defer 'verschoben nach A38 — es fehlt ein Pilotprojekt **und** deine SSH-Entscheidung' \
      '§22 Schritt 5. Die Mechanik ist gegen einen echten Docker-Daemon bewiesen (`compose.itest.ts`: kaputtes Release → Rollback → die URL bedient wieder das gute), und `check-static-rsync.mjs` ist am 3.8.2026 gegen einen echten Host gelaufen. Was fehlt, ist zweierlei: ein Projekt mit `deploy_config.method != none` (also der Klon), und für `static-rsync` die Sicherheitsentscheidung des Betreibers über den SSH-Zugang zum Release-Host'

# --- G6 ---------------------------------------------------------------------
headline 'G6 — Runbook vollständig · Kaltstart gesund · Watchdog spannt neu'
# Zwei Hälften, **eine** Zeile (A113). Die erste ist eine Repo-Eigenschaft und
# heute prüfbar; die zweite braucht einen echten Neustart des Produktionshosts.
fehlend=""
for thema in \
  'Start, stop and state of the stack' \
  'Restore a backup' \
  'Renew the OAuth token' \
  'Passkey rescue' \
  'What the watchdog does' \
  'Disk space' \
  'Account checklist'
do
  grep -q "^## .*${thema}" docs/OPERATIONS.md || fehlend="$fehlend · $thema"
done
if [ -n "$fehlend" ]; then
  red "dem Runbook fehlen Abschnitte:$fehlend"
else
  todo 'Runbook vollständig — der Kaltstart fehlt' \
       "§22 Schritt 4–6. Alle sieben von §22 verlangten Abschnitte stehen in docs/OPERATIONS.md (seit A150), einschliesslich des Plattenplatz-Abschnitts, auf den jeder ausgelieferte Alarm verweist und den es bis dahin nicht gab. Offen bleibt die zweite Hälfte: ein **echter Neustart des Produktionshosts**, und „der Watchdog spannt neu\" ist damit nicht durch \`systemctl is-active\` belegbar — es braucht zwei Dienstläufe mit verschiedenen InvocationIDs in **diesem** Boot. Das ist des Betreibers Zustimmung mit Zeitfenster, denn der Produktionshost trägt andere Stacks mit"
fi

# --- G7 ---------------------------------------------------------------------
headline 'G7 — Wochenberichte der Pilotwochen vom Betreiber als nützlich beurteilt'
todo 'Uhr, plus eine fehlende Eskalationsquelle' \
     '§16. Der Bericht entsteht seit dem 18.8. jeden Montag von selbst; seit A150 gibt es auch den Versandweg, und es fehlt nur das Mailkonto des Betreibers. Für die **Beurteilung** fehlt eine Quelle: `ESCALATION_SOURCES` kennt keine, und `agent_question` wäre die falsche — sie ist der einzige Eintrag in `POLICY_MEMORY_SOURCES`, die zweite Abnahme würde also aus der ersten beantwortet. Genau derselbe Fall wie `design_signoff` (A137)'

# --- G8 ---------------------------------------------------------------------
headline 'G8 — Schlussprüfung über alle neun Phasen, jede Domäne mindestens einmal'
# Nur Dateien, die wirklich ein Bericht sind: `YYYY-MM-DD-<8 hex>-<domäne>.md`.
# Ohne das Muster zählte seit dem 25.8.2026 auch `README.md` als gefahrene
# Domäne — der Index des Verzeichnisses als sein eigener Inhalt, dieselbe
# Verwechslung, die A153.6 im Bestandstest schliesst.
GEFAHREN="$(ls -1 docs/pruefberichte/ 2>/dev/null \
  | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9a-f]{8}-[a-z_]+\.md$' \
  | sed 's/.*-\([a-z_]*\)\.md/\1/' | sort -u | tr '\n' ' ')"
ALLE="$(grep -o "id: '[a-z_]*'" packages/core/src/audit/domains.ts | sed "s/id: '//; s/'//" | sort -u | tr '\n' ' ')"
FEHLT=""
for d in $ALLE; do
  case " $GEFAHREN " in *" $d "*) ;; *) FEHLT="$FEHLT $d" ;; esac
done
N_ALLE=$(printf '%s\n' $ALLE | wc -l)
N_FEHLT=$(printf '%s\n' $FEHLT | grep -c . || true)
if [ -n "$FEHLT" ]; then
  # Die Zahl kommt aus derselben Rechnung wie die Liste daneben. Bis zum
  # 25.8.2026 stand hier „vier von acht" fest verdrahtet, während die Zeile
  # darüber sechs ausrechnete — eine Überschrift, die ihrer eigenen Begründung
  # widerspricht, ist genau der Zustand, den §8.2s erste Domäne sucht.
  todo "$N_FEHLT von $N_ALLE Domänen haben noch keinen eingecheckten Prüfbericht" \
       "§8.2. Gefahren:$( [ -n "$GEFAHREN" ] && printf ' %s' "$GEFAHREN" ). Es fehlen:$FEHLT. Jede kostet eine Sitzung der stärksten Stufe. Zusätzlich verlangt das Gate, dass **jedes verschobene Gate von A38 auf dem Produktionshost nachgeholt** ist — heute fünf. Lauf: infra/scripts/audit-remote.sh --host <ssh-host> --domain <domäne> --trigger phase_close"
else
  todo 'alle Domänen abgedeckt — die Schlussprüfung selbst fehlt' \
       '§22 Schritt 6. Sie muss auf `unbedenklich` schliessen oder jeder offene Fund vom Betreiber ausdrücklich hingenommen sein'
fi

# --- G9 ---------------------------------------------------------------------
headline 'G9 — Endabnahme durch den Betreiber: „Vorschicht v1.0 accepted"'
todo 'die Unterschrift des Betreibers, und die Quelle dafür fehlt noch' \
     '§22. Wie G7: `ESCALATION_SOURCES` hat keinen Eintrag dafür, und `agent_question` wäre aus demselben Grund falsch. Eine eigene Quelle `final_acceptance` nach A137s Muster, **nicht** in `POLICY_MEMORY_SOURCES`'

printf '\n\033[1mErgebnis:\033[0m %d grün · %d verschoben · %d offen · %d rot\n' \
  "$pass" "$deferred" "$open" "$fail"
printf 'Protokoll: %s\n' "$LOG"
[ "$fail" -gt 0 ] && exit 1
exit 0
