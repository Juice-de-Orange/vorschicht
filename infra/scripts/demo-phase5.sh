#!/usr/bin/env bash
# =============================================================================
# Phase 5 exit-gate demonstration (§22).
#
#   infra/scripts/demo-phase5.sh [--on-host] [--with-docker]
#
# Runs the assertions behind each Phase 5 gate rather than describing them, and
# says plainly which of the nine are not settled yet — this phase is in
# progress, so an honest report has open lines in it. Gate states follow A38:
# [x] green · [~] deferred with the command that will prove it · [ ] open, with
# the step of §22 that will close it.
#
# What this script can and cannot say, stated once so nothing below has to
# repeat it. §12's two real deploy methods are proven against in-process
# machines (`fake-machines.ts`), which is what makes them provable at all on a
# laptop with neither daemon installed. Every command shape asserted there was
# measured against docker 29.3.1 / compose v5.1.1 first, but a passing run of
# *those* suites is a statement about Vorschicht's half — which argv, in which
# order, and what it concludes from what comes back — never about docker.
#
# `--with-docker` adds the part that is a statement about the machine: three
# journeys against a real daemon, where what is asserted is the body the health
# URL returns and the image the running container carries. It costs about
# ninety seconds and builds three images, which is why it is opt-in here — the
# same posture `--with-real-sessions` takes in demo-phase2.sh and demo-phase3.sh
# for a step that is expensive rather than uncertain. Note that `pnpm gate`'s
# `test-integration` step runs those journeys anyway whenever docker is
# reachable, so the flag governs this script's runtime and not whether the proof
# happens.
#
# The pattern is demo-phase4.sh's, and so is the reasoning: the integration
# specs skip themselves without TEST_DATABASE_URL, so the database is started
# once for the whole run and its absence is a hard stop rather than a skip — a
# script that reports green while asserting nothing is worse than no script.
#
# Exit codes: 0 = no gate is red · 1 = a gate that should hold does not.
# Open gates do not make this script fail; they make it say what is left.
# =============================================================================
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 2
ON_HOST=0
WITH_DOCKER=0
for arg in "$@"; do
  [ "$arg" = '--on-host' ] && ON_HOST=1
  [ "$arg" = '--with-docker' ] && WITH_DOCKER=1
done

pass=0; fail=0; deferred=0; open=0
green()    { printf '  \033[32m[x]\033[0m %s\n' "$1"; pass=$((pass+1)); }
red()      { printf '  \033[31m[ ]\033[0m %s\n' "$1"; fail=$((fail+1)); }
defer()    { printf '  \033[33m[~]\033[0m %s\n       → %s\n' "$1" "$2"; deferred=$((deferred+1)); }
todo()     { printf '  \033[34m[ ]\033[0m %s\n       → %s\n' "$1" "$2"; open=$((open+1)); }
headline() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Ein Pfad je **Lauf**, nicht je Skript (A121). Auf dieser Maschine liegen
# vierzehn Worktrees; zwei gleichzeitige Nachweislaeufe leerten sonst dieselbe
# Datei, aus der der andere gerade liest. Das ist kein Absturz, sondern ein
# falsches Rot — und ein falsches Rot liest sich wie ein Befund.
LOG="${TMPDIR:-/tmp}/vorschicht-demo-phase5-$$.log"
: > "$LOG"

suite() {
  ./infra/scripts/with-test-db.sh ./node_modules/.bin/vitest run --reporter=verbose "$@" \
    >>"$LOG" 2>&1
}

# A test that ran *and passed*, by name. The verbose reporter puts the mark and
# the name at opposite ends of one line, so the match is the name anywhere on a
# line that begins with the pass mark — a failed test carries `×` and therefore
# does not satisfy it, which is the whole reason to look at the mark.
# Ein Escape-Zeichen, portabel erzeugt: \x1b in einem sed-Ausdruck ist eine
# GNU-Erweiterung, und diese Skripte sollen auch dort laufen, wo sed das nicht
# kennt.
ESC=$(printf '\033')

ran_green() {
  # Farbenblind, und zwar absichtlich. Vitest faerbt auch dann, wenn seine
  # Ausgabe in eine Datei geht (gemessen am 16.8.2026 im Gate-Container), und
  # das Haekchen steht dann nicht mehr am Zeilenanfang. Die Demo meldete
  # daraufhin "haelt seine Zusicherungen nicht", waehrend alle neunzehn
  # Zusicherungen gruen waren — ein Fehlalarm derselben Klasse, die A115 eine
  # Ebene hoeher behoben hat. Eine Pruefung, die aus einem Grund rot wird, der
  # mit ihrem Gegenstand nichts zu tun hat, ist eine Pruefung, die niemand mehr
  # liest.
  sed "s/${ESC}\[[0-9;]*m//g" "$LOG" | grep -F "$1" | grep -q '^ *✓'
}

assertions() {
  sed "s/${ESC}\[[0-9;]*m//g" "$LOG" | grep -oE 'Tests +[0-9]+ passed' | tail -1 | grep -oE '[0-9]+' | head -1
}

printf '\033[1mPhase 5 — Deployment-Maschine (§22)\033[0m\n'
[ "$ON_HOST" = 1 ] && printf 'Lauf auf dem Produktionshost.\n'

# Der Baum, nicht die Artefakte.
#
# Jede Suite hier importiert `@vorschicht/db` über den Paketnamen, die Suite aus
# `apps/orchestrator` zusätzlich `@vorschicht/core` — also aus `packages/*/dist`.
# Ohne Build bricht ein frischer Checkout mit „Failed to resolve entry for
# package" ab; mit einem *veralteten* Build ist es schlimmer, weil der Lauf dann
# eine Aussage über ein Artefakt macht und nicht über den Baum, und das in beide
# Richtungen falsch sein kann — beim Schreiben dieses Blocks stand eine längst
# zurückgenommene Änderung noch in `dist` und färbte einen korrekten Baum rot.
# `--force`, weil `tsc --build` sonst Zeitstempeln vertraut, und genau diese
# Annahme soll hier nicht tragen. (`pnpm gate` deckt das ab, weil sein erster
# Schritt `gate:typecheck` mit `tsc --build --force` beginnt; dieses Skript läuft
# auch allein.)
printf 'Baue die Pakete neu, damit die Suiten den Baum prüfen … '
if ! npx tsc --build --force >>"$LOG" 2>&1; then
  printf '\n'
  red "der Build schlug fehl — ohne ihn prüfen die Suiten ein altes Artefakt. Siehe $LOG"
  printf '\n\033[1mErgebnis:\033[0m %d grün · %d verschoben · %d offen · %d rot\n' \
    "$pass" "$deferred" "$open" "$fail"
  exit 1
fi
printf 'fertig.\n'

# One run: the engine's integration cases share a database, and the two target
# suites need none — starting the database once is cheaper than twice and the
# unit half proves in passing that it needs no machine.
suite packages/core/src/deploy/target-contract.test.ts packages/core/src/deploy/compose.test.ts \
      packages/core/src/deploy/static-rsync.test.ts packages/core/src/deploy/service.itest.ts

# --- the shared contract: one suite, three implementations --------------------
headline 'Der geteilte DeployTarget-Vertrag — dieselben Zusicherungen für alle drei'
vertrag=0
for ziel in fake compose static-rsync; do
  # Named per implementation rather than once: a suite that ran for two of three
  # and was reported as "the contract holds" would be exactly the claim §8.2's
  # first domain exists to check.
  ran_green "$ziel: DeployTarget-Vertrag (§12, A11, A24) > veröffentlicht, ohne auszuliefern" \
    || vertrag=1
  ran_green "$ziel: DeployTarget-Vertrag (§12, A11, A24) > zählt die Releases neueste zuerst auf" \
    || vertrag=1
  ran_green "$ziel: DeployTarget-Vertrag (§12, A11, A24) > tauscht zweimal auf dasselbe Artefakt" \
    || vertrag=1
  ran_green "$ziel: DeployTarget-Vertrag (§12, A11, A24) > tauscht auch auf ein älteres Artefakt" \
    || vertrag=1
  ran_green "$ziel: DeployTarget-Vertrag (§12, A11, A24) > behält beim Aufräumen genau keep" \
    || vertrag=1
  ran_green "$ziel: DeployTarget-Vertrag (§12, A11, A24) > entfernt niemals das Release" \
    || vertrag=1
done
if [ "$vertrag" = 0 ]; then
  green "alle drei Ziele erfüllen denselben Vertrag — auch FakeDeployTarget, das dabei einen echten Abweichler hergab: sein prune löschte das Release, das es bediente ($(assertions) Zusicherungen im Lauf)"
else
  red 'der geteilte Vertrag hält nicht für jedes Ziel — siehe '"$LOG"
fi

# --- §22 Schritt 2: die beiden echten Ziele -----------------------------------
headline '§22 Schritt 2 — Image je Commit, Release-Verzeichnisse und der current-Symlink'
ziele=0
# compose: die Befehlsform, die A11s „Image je git-SHA" tatsächlich ausmacht.
ran_green 'baut, gibt dem Ergebnis den Release-Namen und liefert nichts aus' || ziele=1
ran_green 'reicht die Compose-Dateien in der konfigurierten Reihenfolge durch' || ziele=1
ran_green 'tauscht, indem es den Zeiger umhängt und den Dienst neu erzeugt' || ziele=1
ran_green 'sortiert selbst, auch wenn die Maschine falsch herum antwortet' || ziele=1
ran_green 'hält den Zeiger-Tag niemals für ein Release' || ziele=1
ran_green 'trennt Registry-Port und Tag richtig' || ziele=1
# static-rsync: A24s Form, und die eine Zusicherung, die Atomizität sehen kann.
ran_green 'baut, legt das Releases-Verzeichnis an und lädt genau dorthin hoch' || ziele=1
ran_green 'behält die abschließenden Schrägstriche auf beiden Seiten' || ziele=1
ran_green 'tauscht atomar: erst ein Hilfs-Symlink, dann ein mv -T auf current' || ziele=1
ran_green 'liest die Releases mit ls -1t und sortiert deshalb nicht selbst' || ziele=1
if [ "$ziele" = 0 ]; then
  green 'compose: config --images → build → tag, Tausch als Zeiger-Umhängung · static-rsync: releases/<sha> und ein current, das genau einmal geschrieben wird — per mv -T, nie per rm+ln'
else
  red 'die Befehlsformen der beiden Ziele halten nicht — siehe '"$LOG"
fi

# --- was beide Ziele verweigern ----------------------------------------------
headline '§19 und A83.6 — was beide Ziele ablehnen, statt es zu raten'
schutz=0
# Fail-closed, an genau der Stelle, an der ein Irrtum Produktion löscht.
ran_green 'löscht nichts, wenn unklar ist, welches Image läuft' || schutz=1
ran_green 'löscht nichts, wenn current da ist, aber kein Symlink' || schutz=1
ran_green 'löscht nichts, wenn der Host beim Nachsehen nicht erreichbar ist' || schutz=1
ran_green 'löscht nichts, was die Maschine selbst aufzählt und kein Release ist' || schutz=1
ran_green 'liest jeden anderen Fehler nicht als „es gibt keine Releases"' || schutz=1
# §19: die ferne Seite ist eine Shell, und was dorthin geht, trägt kein Sonderzeichen.
ran_green 'weist ein Ziel ohne Host ab, statt ins lokale Dateisystem zu laden' || schutz=1
ran_green 'weist ein Ziel mit Shell-Sonderzeichen ab und benennt das Zeichen' || schutz=1
ran_green 'weist einen Build-Befehl mit Shell-Sonderzeichen ab, bevor er läuft' || schutz=1
ran_green 'weist auch einen Namen ab, der sich aus releases/ heraus bewegt' || schutz=1
ran_green 'weist einen Stand ab, der kein Docker-Tag sein kann — vor jedem Befehl' || schutz=1
if [ "$schutz" = 0 ]; then
  green 'unklar heißt nirgends „darf löschen" · kein konfigurierter Wert erreicht die ferne Shell mit einem Sonderzeichen · kein Name aus der Maschinen-Antwort landet ungeprüft in einem rm -rf'
else
  red 'die Verweigerungen halten nicht — siehe '"$LOG"
fi

# --- die Maschine selbst, gegen das Fake-Ziel ---------------------------------
headline '§12 — Reihenfolge, Rollback und alles, was den Rollout anhält'
maschine=0
ran_green 'rollt aus, prüft die Gesundheit und schließt die Aufgabe ab' || maschine=1
ran_green 'hält A24s Reihenfolge ein: erst migrieren, dann tauschen, dann prüfen' || maschine=1
ran_green 'bricht ab, bevor etwas getauscht wird, wenn die Migration scheitert' || maschine=1
ran_green 'rollt auf das letzte gesunde Release zurück und prüft es erneut' || maschine=1
ran_green 'meldet P0, wenn auch das Zurückrollen nicht gesund wird' || maschine=1
if [ "$maschine" = 0 ]; then
  green 'migrieren → tauschen → prüfen, Rollback auf das letzte gesunde Release und die P0-Karte, wenn auch das nicht gesund wird'
else
  red 'die Maschine aus §12 ist nicht nachgewiesen — siehe '"$LOG"
fi

# --- die Strecke durch den Ablaufplaner ---------------------------------------
#
# Alles oben ist eine Aussage über einzelne Bauteile, jedes für sich aufgerufen.
# Drei der neun Gates fragen aber nach einer *Strecke*: was passiert, wenn der
# Tick die Maschine ruft und nicht ein Testfall. Das ist die einzige Ebene, auf
# der „endet am Merge", „läuft nach dem Reset" und „auch beim nächsten Tick
# nicht" überhaupt Sätze sind — ein einzelner Aufruf kann keinen davon
# beantworten, weil jeder von ihnen von dem handelt, was *danach* passiert.
#
# Ein Lauf, drei Dateien, gefiltert auf die beiden Blöcke, um die es geht: der
# echte `Scheduler` gegen echte Postgres, echtes git und die echte
# `DeployService`. Die Attrappe ist nur das Deploy-Ziel (A37) — was auf einer
# Maschine bedient, ist die Frage der Docker-Strecke oben und nicht diese hier.
headline 'Die Strecke durch den Ablaufplaner — §22 Schritte 3, 5 und 6'
suite packages/core/src/scheduler.test.ts packages/core/src/merge-queue.itest.ts \
      apps/orchestrator/src/build-scheduler.itest.ts \
      -t 'Ablaufplaner|Deploy-Maschine'

# Je Gate eine eigene Variable: ein Gate, das grün wird, weil die Zusicherungen
# eines anderen liefen, ist genau der Fehler, den §8.2s erste Domäne sucht.
ohne_deploy=0
ran_green 'führt eine Aufgabe vom Tick bis `done` und rollt dabei nichts aus' || ohne_deploy=1

wrapup=0
ran_green 'lässt einen Rollout im wrap_up liegen und rollt ihn beim Reset aus' || wrapup=1
ran_green 'nimmt ein `deferred` der Maschine hin und rollt beim nächsten Tick aus' || wrapup=1
ran_green 'holt einen im wrap_up übersprungenen Rollout beim nächsten `normal` sofort nach' || wrapup=1

selbst=0
ran_green 'fragt bei einem Selbst-Deploy erst nach und rollt nach der Freigabe aus (A12)' || selbst=1
ran_green 'rollt ohne Freigabe auch über viele Ticks nichts aus — und fragt nur einmal (A12)' || selbst=1

if [ "$ohne_deploy" = 0 ]; then
  green 'Ein Projekt mit deploy: none endet am Merge mit korrektem Endzustand — drei Ticks: Kette, Merge, nichts mehr. Die Abwesenheit ist die tragende Hälfte und wird dreifach abgelesen: die Maschine wurde nie gefragt, nichts wurde zurückgestellt, und es steht weder eine Übergabe in der Zeitleiste noch ein Release in der Historie'
else
  red 'die Strecke ohne Deployment hält nicht — siehe '"$LOG"
fi
if [ "$wrapup" = 0 ]; then
  green 'Deploy-Versuch im simulierten wrap_up wird zurückgestellt und läuft nach dem Reset — beide Ebenen: der Tick, der außerhalb von `normal` gar nichts anfasst, und die Maschine, der das Fenster zwischen ihrer und der Lesung des Ticks zufällt (`deferred`). Danach jeweils der *nächste* Tick, ohne Uhrvorlauf: kein Backoff, keine Rückstellung, kein Wiederholungszähler. Dazu §7.2s Ausnahme ausgeführt statt zitiert — der echte Aufräum-Lauf parkt eine Aufgabe in `deploying` nicht'
else
  red 'der zurückgestellte Rollout hält nicht — siehe '"$LOG"
fi
if [ "$selbst" = 0 ]; then
  green 'Selbst-Deploy ohne Freigabe wird verweigert, mit Freigabe läuft er — beide Hälften durch dieselbe Verdrahtung, die der Daemon benutzt: ohne Freigabe über fünf Ticks kein Tausch, kein gebautes Artefakt und genau *eine* Karte; mit des Betreibers Antwort rollt derselbe Aufbau im nächsten Tick aus'
else
  red 'A12 hält nicht über mehrere Ticks — siehe '"$LOG"
fi

# --- die Strecke gegen einen echten Docker-Daemon ------------------------------
#
# Alles oben ist eine Aussage über *unsere* Hälfte: welche Befehle, in welcher
# Reihenfolge, und was daraus geschlossen wird. Was drei der neun Gates
# tatsächlich fragen, ist eine andere Frage — nämlich „was bedient gerade" —,
# und die kann eine Attrappe nicht beantworten: sie antwortet aus demselben
# Modell, gegen das das Ziel geschrieben wurde, ein gemeinsamer Irrtum hebt sich
# also auf. Hier wird gebaut, getauscht, wirklich per HTTP gefragt und wirklich
# zurückgerollt; geprüft wird die *Antwort* der Gesundheits-URL und das Image
# des laufenden Containers, nie die abgesetzten Befehle.
headline '§12 gegen einen echten Docker-Daemon — was bedient, statt was aufgerufen wurde'
if [ "$WITH_DOCKER" = 1 ]; then
  suite packages/core/src/deploy/compose.itest.ts
  echt=0
  ran_green 'rollt einen echten Container aus, prüft die echte Gesundheits-URL und räumt nach A11 auf' \
    || echt=1
  ran_green 'rollt ein erzwungen kaputtes Release zurück — und die Gesundheits-URL liefert wieder das gute' \
    || echt=1
  ran_green 'hält A24s Reihenfolge gegen eine echte Migration: scheitert sie, bedient der alte Container weiter' \
    || echt=1
  if [ "$echt" = 0 ]; then
    green 'drei echte Images, drei echte Container: die URL antwortet „ok gruen-drei", das älteste Release ist nach A11 wirklich von der Maschine verschwunden, das erzwungen kaputte (503) rollt zurück und die URL liefert danach wieder „ok gut", und eine gescheiterte Migration lässt den alten Container bedienen'
  else
    red 'die Strecke gegen den echten Daemon hält nicht — siehe '"$LOG"
  fi
else
  defer 'die Strecke gegen einen echten Docker-Daemon' \
        'infra/scripts/demo-phase5.sh --with-docker (drei Images, drei Container, ~90 s) — dieselben Fälle laufen ohnehin in `pnpm gate`, Schritt test-integration, sobald ein Daemon erreichbar ist'
fi

# --- was noch offen ist -------------------------------------------------------
#
# Sieben der neun Gates sind belegt, eines ist nach A38 verschoben, eines offen.
# Der Maßstab bleibt derselbe: die Gates aus §22 verlangen jeweils eine
# *Strecke* — grüner Merge → Deploy → Gesundheit → Datensatz in der Oberfläche —,
# und was oben unter „Bauteile" grün ist, sind ihre Bestandteile. Ein Gate
# anzuhaken, weil seine Teile halten, ist genau der Fehler, den §8.2s erste
# Domäne sucht.
#
# Die Haken in `CLAUDE.md` selbst setzt der Phasenabschluss, nicht dieses
# Skript: hier steht, was heute nachweislich läuft, dort steht, was die Phase
# behauptet — und die beiden auseinanderzuhalten ist der ganze Zweck von §8.2s
# erster Domäne.
headline 'G8 — Release-Historie vollständig und konsistent mit git'
suite packages/core/src/merge-queue.itest.ts
g8=0
ran_green 'bestätigt die selbst erzeugte Historie gegen git — und findet erfundene (§22 G8)' || g8=1
ran_green 'meldet ein Repository, das gar nicht lesbar ist, statt grün zu sagen (§22 G8)' || g8=1
if [ "$g8" = 0 ]; then
  green 'die Historie aus einem echten Merge löst in git auf und liegt auf dem Integrationszweig; eine erfundene sha wird `unknown_commit`, ein echter Seitenzweig-Commit `not_on_branch`, ein unlesbares Repository ein Befund statt grün'
else
  red 'die Historie ist nicht gegen git geprüft — siehe '"$LOG"
fi

headline 'G2 — static-rsync gegen einen echten Host (A38)'
defer 'Release-Verzeichnisse, atomarer current-Flip, Rollback per Flip, keep-N' \
      'es fehlt ausschließlich ein vom Betreiber benannter Release-Host. Die Prüfung liegt bei und ist gelaufen: infra/scripts/check-static-rsync.mjs --target host:/pfad — am 3.8.2026 gegen den Produktionshost (<ssh-host>:/tmp) vier von vier grün, nichts liegengeblieben. Das beweist das Skript, nicht das Gate'

headline 'Noch offen — was diese Phase zum Abschluss braucht'
todo 'Betriebsprüfung (§8.2) für diese Phase, Urteil aufgezeichnet' \
     'gehört an den Phasenabschluss und läuft mit einer echten Sitzung der stärksten Stufe: ./infra/scripts/run-audit.sh'

if [ "$ON_HOST" = 1 ]; then
  headline 'Auf dem Produktionshost — was hier zusätzlich zu prüfen wäre'
  defer 'die beiden Ziele gegen echten Docker-Daemon und echten Release-Host' \
        'die Befehlsformen sind gegen docker 29.3.1 / compose v5.1.1 gemessen worden; ein Lauf gegen eine echte Maschine gehört an das Ende von Phase 5 und nach A38 an Phase 9'
fi

printf '\n\033[1mErgebnis:\033[0m %d grün · %d verschoben · %d offen · %d rot\n' \
  "$pass" "$deferred" "$open" "$fail"
printf 'Protokoll: %s\n' "$LOG"
[ "$fail" = 0 ] || exit 1
