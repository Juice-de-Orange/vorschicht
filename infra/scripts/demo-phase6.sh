#!/usr/bin/env bash
# =============================================================================
# Phase 6 exit-gate demonstration (§22).
#
#   infra/scripts/demo-phase6.sh [--on-host] [--with-real-sessions]
#
# Runs the testfaelle behind each Phase 6 gate rather than describing them, and
# says plainly which of the nine are not settled yet. Gate states follow A38:
# [x] green · [~] deferred with the command that will prove it · [ ] open, with
# the step of §22 that will close it.
#
# **Written at the start of the phase, not at its end, and that is the point.**
# The other six demo scripts were each written when their phase was nearly
# done, which makes them summaries. This one is a running tally, and it is
# updated as blocks land — not as a claim about what the phase will prove. The
# alternative — writing it last — is nine claims made at once by whoever is
# tired, and P5.G8 was invalidated twenty minutes after exactly that.
#
# The one thing this script does **not** do is tick anything in `CLAUDE.md`.
# Here stands what demonstrably runs today; there stands what the phase claims,
# and keeping those apart is the whole purpose (A90, A95).
#
# The pattern is demo-phase5.sh's, and so is the reasoning: the integration
# specs skip themselves without TEST_DATABASE_URL, so every suite call goes
# through `with-test-db.sh` and a missing docker is a hard stop rather than a
# skip — a script that reports green while asserting nothing is worse than no
# script. That script starts a throwaway container **per invocation**, so the
# gates below cost one container each; the alternative, one database for the
# whole run, would trade a few seconds for a suite that inherits the previous
# one's rows.
#
# `--with-real-sessions` adds the one gate of this phase whose sentence cannot
# be settled without a model turn: G1 says *Lena answers*, and no fixture
# answers a question. It costs two real sessions of the strongest tier, which is
# why it is opt-in — the same posture demo-phase2.sh and demo-phase3.sh take for
# a step that is expensive rather than uncertain. Known and stated rather than
# smoothed: `check:legal-review` is roughly one run in four red on clean code,
# and a silent retry was deliberately not built, so a red line there is a claim
# about *this* run and not automatically about the tree.
#
# Every gate carries its own error variable, and every suite call its own
# assertion count. Both are deliberate: a gate that reads green because a
# neighbour's testfaelle ran is §8.2's first domain exactly, and a count that
# silently includes another gate's files is the same error wearing a number.
#
# Exit codes: 0 = no gate is red · 1 = a gate that should hold does not.
# Open gates do not make this script fail; they make it say what is left.
# =============================================================================
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 2
ON_HOST=0
REAL=0
for arg in "$@"; do
  [ "$arg" = '--on-host' ] && ON_HOST=1
  [ "$arg" = '--with-real-sessions' ] && REAL=1
done

pass=0; fail=0; deferred=0; open=0
green()    { printf '  \033[32m[x]\033[0m %s\n' "$1"; pass=$((pass+1)); }
red()      { printf '  \033[31m[ ]\033[0m %s\n' "$1"; fail=$((fail+1)); }
defer()    { printf '  \033[33m[~]\033[0m %s\n       → %s\n' "$1" "$2"; deferred=$((deferred+1)); }
todo()     { printf '  \033[34m[ ]\033[0m %s\n       → %s\n' "$1" "$2"; open=$((open+1)); }
headline() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Ein Pfad **je Lauf**, nicht je Skript — dieselbe Bauart und dieselbe Begründung
# wie `with-test-db.sh`s `vorschicht-testdb-$$`.
#
# Gemessen, nicht befürchtet: dieses Projekt hat vierzehn Worktrees, und während
# eines Laufs von hier startete jemand denselben Nachweis aus dem Hauptbaum. Das
# `: > "$LOG"` des zweiten Laufs leerte das Protokoll, aus dem der erste gerade
# las — Ergebnis war ein **falsches Rot** auf G2 (jede seiner zehn Zusicherungen
# war in Wahrheit grün) und ein „?" an der Stelle, an der G6 das rote
# Vorprojekt nennen sollte. Ein Nachweisskript, das unter Parallelität eine
# Unwahrheit über den Baum druckt, ist schlimmer als keines: sein Rot liest sich
# wie ein Befund und ist eine Kollision im Dateisystem.
LOG="${TMPDIR:-/tmp}/vorschicht-demo-phase6-$$.log"
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

# Vitests Zusammenfassung zaehlt **Testfaelle**, nicht `expect`-Aufrufe. Bis zum
# 11.8.2026 hiess diese Funktion `testfaelle` und ihre Zahl wurde in den gruenen
# Zeilen als „Zusicherungen" gedruckt — von dort wanderte sie in die Belegzeilen
# von CLAUDE.md. Der Irrtum ging in die vorsichtige Richtung (die Zeile behauptet
# weniger, als der Lauf prueft) und war trotzdem eine Belegzeile, die eine andere
# Groesse nennt als die gemessene. Gefunden von der Betriebspruefung f785a443 als
# `process`-Fund; kein Test kann diesen Unterschied sehen (A76.4).
testfaelle() {
  sed "s/${ESC}\[[0-9;]*m//g" "$LOG" | grep -oE 'Tests +[0-9]+ passed' | tail -1 | grep -oE '[0-9]+' | head -1
}

printf '\033[1mPhase 6 — Das volle Studio (§22)\033[0m\n'
[ "$ON_HOST" = 1 ] && printf 'Lauf auf dem Produktionshost.\n'

# Der Baum, nicht die Artefakte. Begründung wörtlich wie in demo-phase5.sh:
# jede Suite importiert `@vorschicht/*` über den Paketnamen, also aus
# `packages/*/dist`. Ohne Build bricht ein frischer Checkout ab; mit einem
# *veralteten* ist es schlimmer, weil der Lauf dann eine Aussage über ein
# Artefakt macht und nicht über den Baum — und das in beide Richtungen.
printf 'Baue die Pakete neu, damit die Suiten den Baum prüfen … '
if ! npx tsc --build --force >>"$LOG" 2>&1; then
  printf '\n'
  red "der Build schlug fehl — ohne ihn prüfen die Suiten ein altes Artefakt. Siehe $LOG"
  printf '\n\033[1mErgebnis:\033[0m %d grün · %d verschoben · %d offen · %d rot\n' \
    "$pass" "$deferred" "$open" "$fail"
  exit 1
fi
printf 'fertig.\n'

# --- G1 ----------------------------------------------------------------------
headline 'G1 — Legal-Demo: Lena beantwortet eine Vereinsfrage mit Zitaten und Vertrauensstufen'
suite packages/core/src/legal-review.test.ts \
      packages/core/src/legal-review.itest.ts \
      packages/shared/src/quellen.test.ts
zus_g1="$(testfaelle)"
legal=0
# Der Gate-Satz endet auf „citations and trust levels shown in the trace" —
# also ist die tragende Zusicherung die Spur, nicht das Urteil.
ran_green 'schreibt Zitationen und beide Stufen in die Spur (§22s Gate-Satz)' || legal=1
# „an L5 legal source": die RIS-Fundstelle trägt, und sie färbt kein anderes
# Gate — A66.2s Regel, ohne die der Fall eine Aussage über den Lauf wäre.
ran_green 'lässt eine Prüfung durch, die auf der RIS-Fundstelle ruht — und färbt kein anderes Gate' || legal=1
# „using an uploaded Statuten document": der Tresor wird gelesen, bevor
# irgendetwas beantwortet wird (§13).
ran_green 'weist auf den Tresor hin, bevor irgendetwas beantwortet wird (§13)' || legal=1
ran_green 'übergibt die zitierbaren Quellen mit Kennung und Stufe' || legal=1
# §14s Schwelle muss Zähne haben, sonst ist „trust levels" Dekoration.
ran_green 'blockiert eine Aussage, die nur auf L2 ruht — und sagt „unter L4 (§14)"' || legal=1
ran_green 'zieht die Schwelle genau zwischen L3 und L4' || legal=1
# Eine Zitation auf eine Kennung, die es nicht gibt, ist etwas anderes als eine
# auf eine zu schwache Quelle — und beides muss blocken.
ran_green 'blockiert eine erfundene Quellenkennung — auch neben einer L5-Quelle' || legal=1
# Fail closed: eine Suite ohne Rechtsprüfung ist niemals grün (A104.4s Regel).
ran_green 'meldet eine Suite ohne Rechtsprüfung als Infrastrukturfehler, niemals als grün' || legal=1

if [ "$legal" != 0 ]; then
  red 'die Rechtsprüfung hält ihre Zusicherungen nicht — siehe '"$LOG"
elif [ "$REAL" = 1 ]; then
  if pnpm check:legal-review >>"$LOG" 2>&1; then
    green "zwei echte Sitzungen: die tragende ruht auf Muster-Statut und RIS-Fundstelle und wird grün, die Gegenprobe auf einer L2-Quelle wird zum Befund — und der Mechanismus darunter steht mit $zus_g1 Zusicherungen (Spur mit Zitation und beiden Stufen, §14s Schwelle zwischen L3 und L4, erfundene Kennung blockt, fehlende Prüfung ist infra statt grün)"
  else
    red 'pnpm check:legal-review fehlgeschlagen — siehe '"$LOG"'. Das Skript ist ~1 von 4 rot auf sauberem Code und hat bewusst keinen stillen Retry: erst der zweite Lauf unterscheidet einen Befund von der Streuung'
  fi
else
  # Der bezahlte Lauf **ist** gefahren worden (2026-08-11, nicht in diesem Lauf):
  # Gegenfall `finding`, tragender Fall `green`, Zitationen auf L5 aufgelöst, und
  # als Beleg für einen echten `docs.search`-Aufruf die Statuten-uuid — eine
  # Kennung, die in keinem Prompt und in keiner Quellenliste steht.
  #
  # Zitiert wie A99.5 den Lauf gegen den Produktionshost zitiert: mit Datum, mit
  # Ergebnis, und mit dem Satz, was er beweist. Eine Verschiebungsbegründung, die
  # verschweigt, dass die Prüfung schon einmal grün war, liest sich wie ein
  # ungebauter Nachweis — und A38 verlangt das Gegenteil, nämlich das Skript
  # beizulegen, das die Verschiebung auflöst. Was fehlt, ist allein ein Lauf in
  # *diesem* Durchgang, und das steht so da.
  defer "der bezahlte Prüflauf lief in diesem Durchgang nicht — der Mechanismus darunter hält ($zus_g1 Zusicherungen: Spur mit Zitation und beiden Stufen, §14s Schwelle, erfundene Kennung, fail closed)" \
        'infra/scripts/demo-phase6.sh --with-real-sessions, also pnpm check:legal-review — zwei echte Sitzungen der stärksten Stufe mit Muster-Statut und RIS-Fundstelle. Am 2026-08-11 gefahren und grün: Gegenfall „finding", tragender Fall „green", Zitationen auf L5 aufgelöst, Statuten-uuid als Beleg für einen echten docs.search-Aufruf. Das beweist den Nachweis, nicht diesen Lauf — kein Fixture beantwortet eine Frage, und der Gate-Satz sagt „is answered by Lena"'
fi

# --- G2 ----------------------------------------------------------------------
headline 'G2 — Radar: Patch → Auto-Task durch die Gates, Major → Postfach-Karte'
suite packages/core/src/scans/radar/scan.itest.ts \
      packages/core/src/scans/radar/dependencies.test.ts \
      packages/core/src/scans/radar/cards.test.ts \
      packages/core/src/scans/radar/billing.test.ts \
      apps/orchestrator/src/radar-wiring.test.ts
zus_radar="$(testfaelle)"
# Ein Lauf für G2 und G3 — `scan.itest.ts` trägt beide Hälften und lässt sich
# nicht nach Gate zerlegen. Deshalb nennt keine der beiden Zeilen unten eine
# Zusicherungszahl: eine geteilte Summe an zwei Gates zu hängen ist genau die
# Überzeichnung, gegen die dieses Skript geschrieben ist.
radar=0
# A10s Politik, an ihren **Abwesenheiten** geprüft: eine Karte, die nebenbei
# eine Aufgabe anlegt, wäre unbeaufsichtigte Arbeit an einer offenen Frage.
ran_green 'Patch: genau eine Aufgabe und keine Karte' || radar=1
ran_green 'Hauptversion: genau eine Karte und keine Aufgabe' || radar=1
ran_green 'schickt Patch und Minor in den Aufgaben-Zweig' || radar=1
ran_green 'schickt eine Hauptversion in den Karten-Zweig' || radar=1
# „researched options" wird nicht behauptet, sondern verneint — die Karte sagt
# selbst, dass sie den Changelog nicht gelesen hat.
ran_green 'sagt, dass der Changelog nicht gelesen wurde' || radar=1
# A93.5/A97: gelesen wird die **gewählte** Option, nicht dass geantwortet wurde.
ran_green 'setzt die handelnde Option auf RADAR_APPROVE_INDEX' || radar=1
ran_green 'legt die Aufgabe an, wenn der Betreiber die handelnde Option wählt' || radar=1
ran_green 'legt nichts an, wenn der Betreiber die ablehnende Option wählt' || radar=1
# „a real dependency proposal": gegen das echte Lockfile dieses Repositories.
ran_green 'liest das echte Lockfile dieses Repositories' || radar=1
ran_green 'meldet einen stummen Kanal als ungeprüft, nicht als «alles aktuell»' || radar=1
if [ "$radar" != 0 ]; then
  red 'A10s Politik hält ihre Zusicherungen nicht — siehe '"$LOG"
else
  todo 'A10s Politik steht in beide Richtungen; zwei Wörter des Gate-Satzes stehen offen' \
       'Belegt ist der Vorschlag gegen das echte Lockfile dieses Repositories, beide Zweige an ihren Abwesenheiten, und die Ausführung erst auf die handelnde Option. Offen: „on a pilot repo" braucht ein schreibbares Projekt (nach A85 ist das einzige Projekt beider Stapel nur lesbar), und „passes gates" verlangt einen echten Merge dort. „researched options" wäre eine Changelog-Recherche und damit eine Modellsitzung — die Karte sagt heute, dass sie nicht gelesen hat, statt Recherche zu behaupten'
fi

# --- G3 ----------------------------------------------------------------------
headline 'G3 — Abrechnungs-/CLI-Radar: gesäte Änderung → P0, CLI-Release → normale Aufgabe'
# Läuft auf demselben Suite-Lauf wie G2, aber mit eigener Fehlervariable: der
# Gate-Satz sagt hier zweimal „seeded", ist also ohne Netzzugriff erfüllbar.
billing=0
ran_green 'macht aus einer gesäten Abrechnungsänderung eine P0-Karte' || billing=1
ran_green 'macht aus einem gesäten Release eine gewöhnliche Aufgabe — und keine Karte' || billing=1
ran_green 'erkennt die Ankündigung, die §6.0 beschreibt' || billing=1
# Ein Melder, der immer feuert, trägt so wenig wie einer, der nie feuert.
ran_green 'schweigt zu Dokumentation über headless-Betrieb' || billing=1
ran_green 'schweigt, wenn der Kanal die festgenagelte Version nennt' || billing=1
ran_green 'ist P0 und wird vom Postfach angenommen' || billing=1
# Die Prüfgrenzen stehen in der Ausgabe des Scans, nicht nur in der Doku.
ran_green 'sagt ausdrücklich, dass der Kanal nur eine Fixture war' || billing=1
ran_green 'meldet einen gar nicht konfigurierten Kanal als ungeprüft, nicht als sauber' || billing=1
# Gebaut und nie gerufen ist in diesem Repo mehrfach passiert (A71, A74.2, A86,
# A91, A108). `main.ts` hat keinen Test, also ist diese Suite das Netz.
ran_green 'registriert den Radar als periodischen Auftrag' || billing=1
ran_green 'vergleicht gegen die festgenagelte CLI-Version aus der Konfiguration' || billing=1
if [ "$billing" = 0 ]; then
  green 'die gesäte Ankündigung wird eine P0-Karte, die den gefundenen Satz zitiert statt ihn zu umschreiben; das gesäte Release wird eine gewöhnliche Aufgabe und keine Karte; Dokumentation über headless-Betrieb und ein Kanal auf der festgenagelten Version lösen nichts aus; ein nicht konfigurierter Kanal heißt ungeprüft und niemals sauber — und der Auftrag ist im Daemon wirklich registriert'
else
  red 'die Abrechnungsbeobachtung hält ihre Zusicherungen nicht — siehe '"$LOG"
fi

# --- G4 ----------------------------------------------------------------------
headline 'G4 — Transkript-Leak-Scan: gesätes Geheimnis → P0, die Klasse benannt (§6.6, A21, A105)'
suite packages/core/src/scans/transcript-leak.test.ts \
      packages/core/src/scans/transcript-leak.itest.ts \
      apps/orchestrator/src/periodic-pass.test.ts
zus_g4="$(testfaelle)"
leak=0
# Der Gate-Satz selbst: gesätes Zugangsdatum, genau eine P0-Karte, Klasse genannt.
ran_green 'findet ein gesätes Zugangsdatum und legt genau eine P0-Karte an (§6.6, A21)' || leak=1
# A21s zweite Hälfte, und die wiegt schwerer: §18 hebt das Ereignisprotokoll für
# immer auf, ein Geheimnis darin ist unwiderruflich.
ran_green 'bringt das Zugangsdatum weder in die Karte noch ins Ereignisprotokoll (A21)' || leak=1
# Ohne Entdopplung wäre es ein P0 pro Nacht — die Regel, die A67.6, A86.5 und
# A102 dreimal aufgestellt haben, im vierten Kanal.
ran_green 'meldet denselben Fund kein zweites Mal' || leak=1
# A104.4: `gitleaks dir` auf ein fehlendes Verzeichnis endet mit 0 und leerer
# Liste. „Konnte nicht lesen" darf niemals „sauber" heißen.
ran_green 'nennt ein unlesbares Archiv infra und niemals sauber (A104.4)' || leak=1
ran_green 'setzt die Marke fort, statt das Archiv jede Nacht neu zu lesen' || leak=1
ran_green 'meldet einen sauberen Tag als sauber, ohne Karte' || leak=1
# Die Verdrahtung: gebaut und nie gerufen ist in diesem Repo mehrfach passiert
# (A71, A74.2, A86, A91, A108 — und beim Leak-Scan selbst). `main.ts` hat keinen Test, also ist
# dieser grep das Netz — er belegt die Aufrufstelle, nie den Lauf.
ran_green 'registriert §6.6s Transkript-Scan als zweiten Auftrag (A105)' || leak=1
if [ "$leak" = 0 ]; then
  green "gegen echte Postgres, echte Dateien und das echte gitleaks — Karte und Protokoll tragen Klasse und Datei, den Fund selbst trägt keins von beiden ($zus_g4 Testfälle im Lauf)"
else
  red 'der Transkript-Scan hält seine Zusicherungen nicht — siehe '"$LOG"
fi

# --- G5 ----------------------------------------------------------------------
headline 'G5 — Idle-Audit auf einem echten Projekt, Funde als P2 mit korrekten Spuren'
suite packages/core/src/idle-audit.test.ts
zus_g5="$(testfaelle)"
idle=0
# Der Gate-Satz nennt drei Dinge — P2, Aufgabe je Fund, Spur zum Lauf — und der
# eine Fall trägt alle drei.
ran_green 'legt je Fund genau eine Aufgabe an, mit P2 und der Spur zum Lauf' || idle=1
# Die Abwesenheit ist die andere Hälfte: ein Dienst, der immer eine Aufgabe
# anlegt, erfüllt den Satz oben auch.
ran_green 'legt keine Aufgabe an, wenn nichts gefunden wurde' || idle=1
ran_green 'führt §21s Liste vollständig und in ihrer Reihenfolge' || idle=1
# A17s dritte Bedingung, und die Grenze ist erreicht statt unterschritten.
ran_green 'läuft nicht bei genau 50 Prozent — die Grenze ist erreicht, nicht unterschritten' || idle=1
ran_green 'verweigert bei einem nicht lesbaren Fenster, statt es für leer zu halten' || idle=1
# Genau der Grund, aus dem dieses Gate nicht schließen kann — und er ist
# geprüft, nicht behauptet.
ran_green 'prüft kein Projekt, das auf Nur-Lesen steht (A44.3)' || idle=1
ran_green 'macht aus einer gescheiterten Sitzung keine rote Aufgabe' || idle=1
ran_green 'läuft im Kratzverzeichnis, nennt das Projekt absolut und darf nichts schreiben' || idle=1
if [ "$idle" != 0 ]; then
  red '§21 hält seine Zusicherungen nicht — siehe '"$LOG"
else
  todo "§21 hält seine Zusicherungen ($zus_g5); es fehlt ein Projekt, auf dem es laufen darf" \
       'Belegt sind der Gate-Satz selbst (je Fund genau eine P2-Aufgabe mit der Spur zum Lauf), seine Abwesenheit, A17s dritte Bedingung an der Grenze und die nur lesende Sitzung im Kratzverzeichnis. Offen ist das Wort „real project": §21 läuft heute faktisch nie, weil das einzige Projekt beider Stapel nach A85 nur lesbar ist und der Ablaufplaner solche überspringt — geprüft ist genau das, im Fall „prüft kein Projekt, das auf Nur-Lesen steht". §22 sagt hier „real project", wo es sonst viermal „sandbox" sagt'
fi

# --- G6 ----------------------------------------------------------------------
headline 'G6 — Tresor: Upload → Tag → Agent holt es über MCP, nach Abteilungs-Tag gewichtet (§13, A107/A110/A111)'
suite packages/core/src/vault/documents.itest.ts \
      packages/mcp/src/server.itest.ts \
      apps/server/src/dokumente.itest.ts
zus_g6="$(testfaelle)"
tresor=0
# Der Gate-Satz endet auf „ranked by department tag", also ist die tragende
# Zusicherung eine **Reihenfolge** und keine Trefferzahl. Zwei Dokumente, die
# denselben Begriff gleich oft tragen — nur der Abteilungs-Tag unterscheidet sie.
ran_green 'liefert der fragenden Abteilung beide Treffer — den getaggten zuerst' || tresor=1
# Der Unterschied zwischen „nicht im Tresor" und „noch nicht gelesen". Ohne ihn
# schließt eine Sitzung aus einer leeren Liste auf ein fehlendes Dokument.
ran_green 'zählt ein nicht lesbares Dokument als vorhanden, aber nicht durchsuchbar' || tresor=1
# A111.2: die Bytes vor der Zeile. Eine Zeile, die auf nichts zeigt, ist ein
# Dokument, das es zu geben scheint.
ran_green 'legt beim Upload die Bytes und die Zeile an — und die Zeile zeigt auf die Bytes' || tresor=1
ran_green 'bricht über der Größengrenze ab, ohne ein Bruchstück zu hinterlassen' || tresor=1
ran_green 'lehnt einen nicht erlaubten Dateityp ab, ohne Bytes zu hinterlassen' || tresor=1
# §19: der Aktor ist die Sitzung, nie 'system' — sonst beantwortet der Prüfpfad
# nur, *dass* etwas geschah.
ran_green 'schreibt die Sitzung als Urheber in den Prüfpfad' || tresor=1
# Die andere Hälfte des Gate-Satzes ist „upload", und das ist eine Oberfläche.
# Sie kann nur ein Browser belegen: eine Datei, die wirklich über die Leitung
# geht, gegen eine echte API und eine echte Datenbank.
#
# **Eine Zeile, nicht zwei.** Beide Hälften gehören zu *einem* Gate, und zwei
# grüne Zeilen für ein Gate hätten die Bilanz „3 grün" bei neun Gates gemeldet,
# von denen zwei grün sind — dieselbe Klasse Überzeichnung, die dieses Skript an
# `CLAUDE.md` prüfen soll.
E2E_LOG="${TMPDIR:-/tmp}/vorschicht-demo-phase6-e2e-$$.log"
browser=0
vorgelagert=0
if ./infra/scripts/with-test-db.sh pnpm exec playwright test --project=vault \
     >"$E2E_LOG" 2>&1; then
  # Nur die eigenen Fälle zählen: `passkey`, `dashboard` und `inbox` laufen als
  # erklärte Abhängigkeiten davor, und ihre Fälle hier mitzuzählen bliese auf,
  # was dieses Gate belegt.
  browserfaelle="$(grep -cF '[vault]' "$E2E_LOG")"
else
  browser=1
  browserfaelle=0
  # Nach A75.6 hängt `vault` an `inbox`, das an `dashboard`, das an `passkey`.
  # Ein rotes Vorprojekt **überspringt** die eigenen Fälle, statt sie abgeleitet
  # rot zu melden — dann ist von diesem Gate nichts geprüft, und „der Tresor
  # hält seine Zusicherungen nicht" wäre die Unwahrheit über eine Suite, die gar
  # nicht gelaufen ist. Es bleibt rot, weil ungeprüft nicht grün ist (A25); was
  # sich ändert, ist der Satz, den ein Mensch danach liest — und der nennt dann
  # das Vorprojekt, statt den Leser in den Tresor zu schicken.
  #
  # Gezählt wird **nicht**, wie viele Tresor-Fälle übersprungen wurden: bricht
  # ein Vorprojekt ab, plant Playwright die abhängigen gar nicht erst ein und
  # schreibt keine einzige `[vault]`-Zeile ins Protokoll. Ein `grep -c` darauf
  # meldet dann 0 und liest sich wie „keiner ausgefallen" — eine erfundene Zahl
  # an genau der Stelle, an der dieser Zweig die Unwahrheit verhindern soll.
  grep -qE '✓.*\[vault\]' "$E2E_LOG" || vorgelagert=1
  # Ohne `✘`-Zeile ist **kein einziger Fall** gelaufen: dann ist Playwright gar
  # nicht erst gestartet, und die häufigste Ursache steht als `Error:` im
  # Protokoll — etwa ein belegter Port 8421, weil ein zweiter Lauf auf dieser
  # Maschine seinen webServer noch hält. Gemessen, nicht erdacht: genau das ist
  # eingetreten, und der Zweig druckte „das vorgelagerte Projekt ? ist rot" —
  # eine Aussage über ein Vorprojekt, das gar nicht gescheitert war. Er wurde
  # gebaut, um solche Sätze zu verhindern, und war selbst einer.
  rotes_projekt="$(grep -oE '✘ +[0-9]+ +\[[a-z0-9-]+\]' "$E2E_LOG" | head -1 |
    grep -oE '\[[a-z0-9-]+\]')"
  startfehler="$(grep -m1 -oE 'Error: .*' "$E2E_LOG")"
fi

# Die beiden Hälften werden getrennt gehalten und erst hier verrechnet: sonst
# behauptet der Satz über das rote Vorprojekt nebenbei, die Suiten seien grün —
# und das wäre wieder eine Aussage, die niemand geprüft hat.
if [ "$tresor" = 0 ] && [ "$browser" = 0 ]; then
  green "Ablage, Suche und MCP-Abruf gegen echte Postgres, echte Dateien und einen echten Browser ($zus_g6 Testfälle plus $browserfaelle Browserfälle) — die Gewichtung ist eine Reihenfolge und keine Trefferzahl, und ein PDF sagt, dass es abgelegt und nicht ausgelesen ist"
elif [ "$tresor" != 0 ]; then
  red 'der Tresor hält seine Zusicherungen nicht — siehe '"$LOG"' und '"$E2E_LOG"
elif [ -z "$rotes_projekt" ]; then
  red "Playwright ist gar nicht erst gestartet — kein einziger Fall gelaufen, also ist nichts geprüft und nach A25 auch nichts festgestellt. Erste Fehlerzeile: ${startfehler:-keine im Protokoll}. Das ist **keine** Aussage über den Tresor — dessen $zus_g6 Zusicherungen sind in diesem Lauf grün. Siehe $E2E_LOG"
elif [ "$vorgelagert" = 1 ]; then
  red "die Browser-Hälfte wurde gar nicht erreicht: das vorgelagerte Playwright-Projekt $rotes_projekt ist rot, also hat Playwright die Tresor-Fälle übersprungen und keinen einzigen davon ausgeführt. Das ist **keine** Aussage über den Tresor — dessen $zus_g6 Zusicherungen sind in diesem Lauf grün. Siehe $E2E_LOG"
else
  red 'die Browser-Hälfte des Tresors ist rot — siehe '"$E2E_LOG"
fi

# --- G7 ----------------------------------------------------------------------
headline 'G7 — Personas: identische Aufgabe mit und ohne, gleichwertige Qualität (§22 G7, A9)'
suite packages/shared/src/personas.test.ts \
      packages/core/src/profiles/profiles.test.ts \
      packages/core/src/personas/settings.itest.ts
zus_g7="$(testfaelle)"
persona=0
# Der tragende Nachweis, und er braucht keinen Modellaufruf: „aus" und
# „Anzeige" unterscheiden sich in **keinem Byte** des Prompts, über die ganze
# Profiltabelle. Zwei identische Prompts können sich nicht verschieden
# verhalten — das ist stärker als jede Stichprobe zweier Läufe.
ran_green 'sends byte-identical prompts with personas off, for every profile (A9)' || persona=1
# Die Gegenprobe, ohne die der Satz oben von einer Funktion erfüllt wäre, die
# ihr Argument ignoriert.
ran_green 'reaches every profile’s prompt when it is switched on' || persona=1
ran_green 'keeps persona flavour out of the prompt unless it is switched on (A9)' || persona=1
# A9: Flavour darf ergänzen, niemals den Auftrag ersetzen.
ran_green 'lets flavour add to the mandate but never replace it' || persona=1
# Die Stufe, die etwas kosten könnte, muss der Betreiber ausdrücklich einschalten.
ran_green 'defaults to display-only (A9)' || persona=1
ran_green 'is nested: names imply nothing is hidden below, flavour implies names' || persona=1
ran_green 'shows the neutral role label when they are off' || persona=1
ran_green 'führt genau eine Zeile pro Änderung, mit dem Aktor der Sitzung (§19, A75.3)' || persona=1

# „spot comparison documented" ist wörtlich ein Dokument, also wird es als
# solches geprüft — und nicht nur auf Existenz: ohne die beiden echten Lauf-Ids
# wäre eine leere Seite mit der richtigen Überschrift genug.
AB=docs/personas-ab-vergleich.md
grep -Fq '1e34188c-eb2f-4471-894d-4dc5983ab97f' "$AB" 2>/dev/null || persona=1
grep -Fq 'ebdf44e2-a89c-49a2-a6e0-5ef8c0be4d1e' "$AB" 2>/dev/null || persona=1
grep -Fq 'sends byte-identical prompts with personas off, for every profile (A9)' "$AB" 2>/dev/null || persona=1

if [ "$persona" = 0 ]; then
  green "der Prompt ist bei ausgeschaltetem Flavour über die **ganze** Profiltabelle byte-identisch, und eingeschaltet erreicht er jedes Profil — die Gegenprobe, ohne die der erste Satz nichts sagt ($zus_g7 Testfälle). Dazu der dokumentierte A/B-Lauf in $AB mit zwei echten Lauf-Ids: gleiche Antwort in beiden Teilen, Unterschiede nur in der Formulierung"
else
  red 'die Persona-Schicht hält ihre Zusicherungen nicht, oder '"$AB"' belegt den A/B-Lauf nicht mehr — siehe '"$LOG"
fi

headline 'G8 — pnpm gate grün; Doku aktuell'
todo 'gehört an den Phasenabschluss' \
     'pnpm gate, und die Doku im selben Commit wie die Haken — P5.G8 wurde genau daran entwertet'

headline 'G9 — Betriebsprüfung (§8.2) für diese Phase, Urteil aufgezeichnet'
todo 'gehört an den Phasenabschluss und kostet eine echte Sitzung der stärksten Stufe' \
     './infra/scripts/run-audit.sh — die Wegwerf-Postgres ist seit A117 kein Thema mehr, das Skript verweigert einen echten Lauf ohne DATABASE_URL. Offen bleibt: ein gate_invalid wird auf dem read_only-Projekt nach A83.6 verweigert (A85s gewollte Folge, gehört so in den Bericht statt als Panne)'

if [ "$ON_HOST" = 1 ]; then
  headline 'Auf dem Produktionshost — was hier zusätzlich zu prüfen wäre'
  defer 'der nächtliche Leak-Scan hat dort wirklich einmal gelaufen' \
        'eine `scan.finished`-Zeile mit `kind: transcript_leak` im Ereignisprotokoll, und `gitleaks --version` im Orchestrator-Container. Beides erst nach dem Rollout am Phasenende'
fi

printf '\n\033[1mErgebnis:\033[0m %d grün · %d verschoben · %d offen · %d rot\n' \
  "$pass" "$deferred" "$open" "$fail"
printf 'Protokoll: %s\n' "$LOG"
[ "$fail" = 0 ] || exit 1
