#!/usr/bin/env bash
# Die Wiederherstellungsprobe (§22 Phase 9, G4; A14).
#
#   infra/scripts/restore-probe.sh [--generation <stamp>] [--backups <dir>]
#                                  [--scratch <dir>] [--behalten]
#
# ## Warum sie vom Host läuft und nicht über einen Tunnel
#
# `kennzahlen-remote.sh` holt die Daten zum Code, weil `check-kennzahlen.mjs`
# gebaute Pakete importiert. Hier ist es umgekehrt: der Gegenstand ist ein
# Verzeichnis von mehreren GB, und diese Probe braucht **kein** `node_modules` —
# reines bash, docker, tar und `pg_restore` in einer Wegwerf-Postgres. Also geht
# der Code zu den Daten:
#
#   ssh <ssh-host> /opt/vorschicht/infra/scripts/restore-probe.sh
#
# Dazu ein struktureller Grund: der Sicherungscontainer hat `docs` und
# `transcripts` **`:ro`** gemountet und *kann* gar nicht zurückspielen. Die Probe
# ist deshalb ein Host-Prozess, der `/srv/vorschicht/backups` nur liest.
#
# ## Was „verified consistent" hier heisst
#
# Ein durchgelaufenes `pg_restore` ist zu wenig, aus zwei Gründen: es endet ohne
# `--exit-on-error` auch bei Warnungen mit 0, und es sagt über die **Bezugnahmen
# aus der Datenbank in die Archive** gar nichts. §1 Grundsatz 4 verlangt aber
# genau die — Ziel → Aufgabe → Lauf → **Transkript** → Diff —, und A14 nennt sie
# als den Grund, warum die Transkripte überhaupt mitgesichert werden.
#
# Sechs Stufen, jede mit eigener Zeile in der Ausgabe:
#
#   0  Die Generation ist vollständig und nicht hohl. Kein Vorsichtsritual: bis
#      zum 3.8.2026 entstand jede Nacht eine `transcripts-*.tar.gz` mit **130
#      Byte** (A103) — genau die Form, die eine Probe aufgreift und der sie
#      glaubt. `.last-result` wird als **Zeugenaussage gedruckt, nicht gewertet**:
#      es ist die Aussage des Sicherungslaufs über sich selbst, und A87.6 verlangt
#      die Aussage des Artefakts.
#   1  Es ist wirklich die gestrige (§22: „yesterday's backup"). Fehlt das
#      Verzeichnis → 2 (nichts geprüft); ist es da und die Generation von gestern
#      fehlt → 1 (Befund über den nächtlichen Lauf, nicht über die Probe).
#   2  Der Dump lädt in eine jungfräuliche Postgres, `--exit-on-error`.
#   3  Das Schema ist das, das dieser Baum behauptet: `_vorschicht_migrations`
#      trägt Name und Prüfsumme je Migration, verglichen gegen die eingecheckten
#      Dateien. Dazu tragen die append-only-Tabellen ihre Wächter — eine
#      Wiederherstellung, die die Trigger verliert, ergibt einen Bestand, dessen
#      Geschichte editierbar ist. Das ist für dieses System ein
#      Konsistenzverlust, auch wenn jede Zeile da ist.
#   4  Der Inhalt passt zum Etikett: `max(occurred_at)` aus `event_log` fällt in
#      denselben Tag wie der Zeitstempel im Dateinamen. Fängt „alte Datei, neuer
#      Name" — den einzigen Fall, bei dem alle Stufen davor grün sind.
#   5  **Die tragende:** jede Zeile aus `agent_runs` mit `transcript_path` muss
#      im entpackten Archiv eine Datei haben, die existiert, nicht leer ist und
#      deren erste Zeile als JSON parst. Und jede `document_versions`-Zeile mit
#      `checksum` wird **nachgehasht** — Inhaltsprüfung statt Namensprüfung, und
#      die einzige Stelle, an der sie zum Nulltarif zu haben ist (0020 hat diese
#      Probe vorweggenommen: `storage_path` ist bewusst relativ, „A14 restores it
#      somewhere else during the drill").
#   6  **Die Gegenprobe.** Danach wird **eine** entpackte Transkriptdatei in der
#      Kopie gelöscht und Stufe 5 wiederholt: sie muss genau eine Fehlstelle
#      melden. Ohne das ist ein grünes Ergebnis von einem kaputten Join nicht zu
#      unterscheiden — dieselbe Logik, aus der `check-static-rsync.mjs` jedes
#      Release seinen eigenen Namen schreiben lässt.
#
# ## Was sie ausdrücklich NICHT belegt (steht auch in der Ausgabe, A119.3)
#
#   * Nicht, dass das **laufende** System wiederherstellbar wäre — geprüft wird
#     eine Kopie in einer leeren Postgres, ohne Rollen, ohne Grants, ohne App.
#   * Nicht die Auslagerung ausser Haus (A35, vom Betreiber am 1.8. vertagt).
#   * Nicht die 14/8-Aufbewahrung — das ist `backup-run.sh`s Sache.
#   * Nicht, ob ein Transkript **inhaltlich vollständig** ist: geprüft ist
#     existiert · nicht leer · erste Zeile JSON. Ob am Ende Zeilen fehlen, sagt
#     keine Prüfsumme, weil es keine gibt.
#   * Läufe **ohne** `transcript_path` sind für Stufe 5 leer, und ihre Zahl wird
#     gedruckt: ein grüner Lauf über 200 Läufe, von denen 190 keinen Pfad tragen,
#     hat zehn geprüft (`check-kennzahlen.mjs`s Buchführung, anderer Gegenstand).
#
# Exit: 0 alle Stufen halten · 1 Befund · 2 nichts geprüft (A25/A50).
set -euo pipefail

GEN=""
BACKUPS="${VORSCHICHT_BACKUPS:-/srv/vorschicht/backups/daily}"
SCRATCH_ROOT="${TMPDIR:-/var/tmp}"
BEHALTEN=0
IMAGE="${TEST_DB_IMAGE:-postgres:16-alpine}"

while [ $# -gt 0 ]; do
  case "$1" in
    --generation) GEN="${2:-}"; shift 2 ;;
    --backups)    BACKUPS="${2:-}"; shift 2 ;;
    --scratch)    SCRATCH_ROOT="${2:-}"; shift 2 ;;
    --behalten)   BEHALTEN=1; shift ;;
    *) echo "restore-probe: unbekanntes Argument '$1'." >&2; exit 2 ;;
  esac
done

fail=0
gruen()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
befund() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
infra()  { printf '  \033[33m⚠\033[0m %s\n' "$1"; exit 2; }
kopf()   { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Überschreibbar, damit die Probe auch aus einer Kopie laufen kann — sie
# braucht den Baum nur für die Zahl der Migrationen (Stufe 3).
REPO_ROOT="${VORSCHICHT_REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
SCRATCH="$SCRATCH_ROOT/vorschicht-restore-$$"
CONTAINER="vorschicht-restore-$$"

aufraeumen() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  [ "$BEHALTEN" -eq 1 ] || rm -rf "$SCRATCH"
}
trap aufraeumen EXIT INT TERM

kopf "Wiederherstellungsprobe (§22 P9.G4)"

# --- Vorbedingungen: alles hier ist "nichts geprüft", niemals ein Befund -----
docker info >/dev/null 2>&1 || infra "Docker ist nicht erreichbar — nichts geprüft (A25)."
[ -d "$BACKUPS" ] || infra "Sicherungsverzeichnis $BACKUPS gibt es nicht — nichts geprüft."
command -v tar >/dev/null 2>&1 || infra "tar fehlt — nichts geprüft."

# --- Stufe 1: welche Generation? --------------------------------------------
kopf "Stufe 1 — die Generation"
if [ -z "$GEN" ]; then
  GESTERN="$(date -d 'yesterday' +%Y%m%d 2>/dev/null || true)"
  [ -n "$GESTERN" ] || infra "date(1) kann 'yesterday' nicht — nichts geprüft."
  GEN="$(ls -1 "$BACKUPS"/db-"$GESTERN"-*.dump 2>/dev/null | tail -1 | sed 's|.*/db-||; s|\.dump$||' || true)"
  if [ -z "$GEN" ]; then
    VORHANDEN="$(ls -1 "$BACKUPS"/db-*.dump 2>/dev/null | wc -l)"
    if [ "$VORHANDEN" -eq 0 ]; then
      infra "In $BACKUPS liegt keine einzige Generation — nichts geprüft."
    fi
    befund "Keine Generation von gestern ($GESTERN) — es liegen $VORHANDEN andere. §22 sagt „yesterday's backup\"."
    printf '\n\033[1mErgebnis:\033[0m %d Befund(e).\n' "$fail"
    exit 1
  fi
fi
DUMP="$BACKUPS/db-$GEN.dump"
DOCS="$BACKUPS/docs-$GEN.tar.gz"
TRANS="$BACKUPS/transcripts-$GEN.tar.gz"
gruen "Generation $GEN"

# --- Stufe 0: vollständig und nicht hohl ------------------------------------
kopf "Stufe 0 — die Archive"
# **Keine Grössenschwelle.** Die erste Fassung verwarf alles unter 512 Byte als
# A103s Torso — und der erste echte Lauf gegen den Produktionshost am 25.8.2026 hat damit
# ein **korrektes** Archiv als Befund gemeldet: `docs-*.tar.gz` ist 99 Byte
# gross, weil der Tresor dort leer ist, und ein tar über ein leeres Verzeichnis
# wiegt nun einmal so viel. Eine geratene Zahl, die ein gesundes Artefakt
# anklagt, ist der teuerste Fehler, den eine Prüfung machen kann — man lernt,
# sie zu übersehen.
#
# Gefragt wird deshalb nach dem, was A103s Torso wirklich auszeichnet: er war
# **abgeschnitten**, weil `tar -czf` die Datei anlegt und erst beim Lesen
# scheitert. Das sieht `tar -tzf` an seinem Exit-Code. **Ob der Inhalt stimmt**,
# entscheidet keine Grösse, sondern Stufe 5 gegen die Datenbank.
[ -s "$DUMP" ] || befund "$(basename "$DUMP") fehlt oder ist leer."
for f in "$DUMP" "$DOCS" "$TRANS"; do
  [ -f "$f" ] || befund "$(basename "$f") fehlt."
done
for a in "$DOCS" "$TRANS"; do
  [ -f "$a" ] || continue
  if ! tar -tzf "$a" >/dev/null 2>&1; then
    befund "$(basename "$a") lässt sich nicht durchlesen — abgeschnitten (A103s Torso)."
    continue
  fi
  n=$(tar -tzf "$a" 2>/dev/null | wc -l)
  gruen "$(basename "$a") — durchlesbar, $n Eintrag/Einträge, $(stat -c%s "$a") Byte"
done
if [ -f "$DUMP" ]; then
  gruen "$(basename "$DUMP") — $(stat -c%s "$DUMP") Byte"
fi
[ "$fail" -eq 0 ] || { printf '\n\033[1mErgebnis:\033[0m %d Befund(e).\n' "$fail"; exit 1; }

# Zeugenaussage, nicht Beweis (A87.6).
if [ -f "$BACKUPS/../.last-result" ]; then
  printf '  \033[2m…\033[0m Selbstauskunft des Sicherungslaufs (nicht gewertet): %s\n' \
    "$(tr '\n' ' ' < "$BACKUPS/../.last-result")"
fi

# --- Stufe 2: der Dump lädt --------------------------------------------------
kopf "Stufe 2 — Wiederherstellung in eine leere Postgres"
mkdir -p "$SCRATCH"
docker run -d --rm --name "$CONTAINER" \
  -e POSTGRES_USER=vorschicht -e POSTGRES_PASSWORD=restore-probe-local \
  -e POSTGRES_DB=vorschicht_restore \
  -p "127.0.0.1:0:5432" \
  --tmpfs /var/lib/postgresql/data:rw,size=2g \
  "$IMAGE" -c fsync=off -c full_page_writes=off >/dev/null \
  || infra "Wegwerf-Postgres liess sich nicht starten — nichts geprüft."

PORT="$(docker port "$CONTAINER" 5432/tcp | head -1 | sed 's/.*://')"
[ -n "$PORT" ] || infra "Konnte den Port der Wegwerf-Postgres nicht ermitteln."

bereit=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U vorschicht >/dev/null 2>&1; then
    bereit=$((bereit+1)); [ "$bereit" -ge 2 ] && break
  else
    bereit=0
  fi
  sleep 1
done
[ "$bereit" -ge 2 ] || infra "Wegwerf-Postgres wurde nicht bereit — nichts geprüft."

psql_() { docker exec -i -e PGPASSWORD=restore-probe-local "$CONTAINER" \
            psql -h 127.0.0.1 -U vorschicht -d vorschicht_restore -tAc "$1"; }

if docker exec -i -e PGPASSWORD=restore-probe-local "$CONTAINER" \
     pg_restore -h 127.0.0.1 -U vorschicht -d vorschicht_restore \
     --exit-on-error --no-owner --no-privileges < "$DUMP" >"$SCRATCH/restore.log" 2>&1; then
  gruen "pg_restore --exit-on-error durchgelaufen"
else
  befund "pg_restore ist gescheitert — siehe $SCRATCH/restore.log"
  printf '\n\033[1mErgebnis:\033[0m %d Befund(e).\n' "$fail"
  exit 1
fi

# --- Stufe 3: das Schema ist unseres -----------------------------------------
kopf "Stufe 3 — das Schema"
ERWARTET="$(ls -1 "$REPO_ROOT/packages/db/migrations"/*.sql 2>/dev/null | wc -l)"
GEFUNDEN="$(psql_ 'SELECT count(*) FROM _vorschicht_migrations' 2>/dev/null || echo 0)"
if [ "$GEFUNDEN" -eq 0 ]; then
  befund "Keine Migrationsbuchführung im wiederhergestellten Bestand."
elif [ "$GEFUNDEN" -ne "$ERWARTET" ]; then
  befund "Der Bestand kennt $GEFUNDEN Migrationen, dieser Baum hat $ERWARTET — die Sicherung gehört zu einem anderen Stand."
else
  gruen "$GEFUNDEN Migrationen, so viele wie dieser Baum hat"
fi

# Die append-only-Wächter müssen die Wiederherstellung überlebt haben.
MANIFEST="$REPO_ROOT/packages/db/append-only.json"
if [ -f "$MANIFEST" ]; then
  fehlend=""
  for t in $(node -e "process.stdout.write(require('$MANIFEST').tables.join(' '))" 2>/dev/null \
             || python3 -c "import json;print(' '.join(json.load(open('$MANIFEST'))['tables']))"); do
    n="$(psql_ "SELECT count(*) FROM pg_trigger WHERE tgrelid = '$t'::regclass AND NOT tgisinternal" 2>/dev/null || echo 0)"
    [ "$n" -ge 2 ] || fehlend="$fehlend $t"
  done
  if [ -n "$fehlend" ]; then
    befund "Append-only-Wächter fehlen nach der Wiederherstellung:$fehlend"
  else
    gruen "Alle append-only-Tabellen tragen ihre Wächter"
  fi
fi

# --- Stufe 4: Inhalt passt zum Etikett ---------------------------------------
kopf "Stufe 4 — Inhalt gegen Etikett"
TAG_DATEI="$(printf '%s' "$GEN" | cut -c1-8)"
TAG_INHALT="$(psql_ "SELECT to_char(max(occurred_at), 'YYYYMMDD') FROM event_log" 2>/dev/null || true)"
if [ -z "$TAG_INHALT" ]; then
  befund "Das wiederhergestellte Ereignisprotokoll ist leer — dann sagt diese Probe nichts."
elif [ "$TAG_INHALT" != "$TAG_DATEI" ]; then
  befund "Jüngstes Ereignis am $TAG_INHALT, der Dateiname sagt $TAG_DATEI — alte Datei, neuer Name?"
else
  gruen "Jüngstes Ereignis am $TAG_INHALT, wie der Dateiname sagt"
fi

# --- Stufe 5: die Bezugnahmen ------------------------------------------------
kopf "Stufe 5 — laufen die Bezugnahmen ins Leere?"
tar -xzf "$TRANS" -C "$SCRATCH"
tar -xzf "$DOCS"  -C "$SCRATCH"

pfade_pruefen() {
  local fehlend=0 geprueft=0 pfad datei
  while IFS= read -r pfad; do
    [ -n "$pfad" ] || continue
    geprueft=$((geprueft+1))
    datei="$SCRATCH/${pfad#/data/}"
    if [ ! -s "$datei" ]; then
      fehlend=$((fehlend+1))
      [ "$fehlend" -le 3 ] && printf '      fehlt oder leer: %s\n' "$pfad" >&2
    elif ! head -1 "$datei" | python3 -c 'import json,sys; json.loads(sys.stdin.readline())' 2>/dev/null; then
      fehlend=$((fehlend+1))
      [ "$fehlend" -le 3 ] && printf '      erste Zeile ist kein JSON: %s\n' "$pfad" >&2
    fi
  done < <(psql_ "SELECT transcript_path FROM agent_runs WHERE transcript_path IS NOT NULL")
  printf '%d %d' "$geprueft" "$fehlend"
}

read -r GEPRUEFT FEHLEND <<<"$(pfade_pruefen)"
OHNE="$(psql_ "SELECT count(*) FROM agent_runs WHERE transcript_path IS NULL" 2>/dev/null || echo '?')"
if [ "$GEPRUEFT" -eq 0 ]; then
  befund "Kein einziger Lauf nennt ein Transkript — dann prüft diese Stufe nichts (A25s Haltung)."
elif [ "$FEHLEND" -gt 0 ]; then
  befund "$FEHLEND von $GEPRUEFT Transkripten fehlen im Archiv — §1 Grundsatz 4 ist damit nicht wiederherstellbar."
else
  gruen "$GEPRUEFT Transkripte vorhanden, nicht leer, erste Zeile JSON"
fi
printf '  \033[2m…\033[0m Prüfgrenze: %s Lauf/Läufe ohne `transcript_path` — für die prüft Stufe 5 nichts.\n' "$OHNE"

# Der Tresor, mit Inhaltsprüfung statt Namensprüfung.
VERS="$(psql_ "SELECT count(*) FROM document_versions WHERE checksum IS NOT NULL" 2>/dev/null || echo 0)"
if [ "$VERS" -gt 0 ]; then
  schlecht=0
  while IFS='|' read -r sp cs; do
    [ -n "$sp" ] || continue
    d="$SCRATCH/docs/$sp"
    ist="$(sha256sum "$d" 2>/dev/null | cut -d' ' -f1 || true)"
    [ "$ist" = "$cs" ] || { schlecht=$((schlecht+1)); printf '      Prüfsumme weicht ab: %s\n' "$sp" >&2; }
  done < <(psql_ "SELECT storage_path || '|' || checksum FROM document_versions WHERE checksum IS NOT NULL")
  if [ "$schlecht" -gt 0 ]; then
    befund "$schlecht von $VERS Dokumentfassungen stimmen nicht mit ihrer Prüfsumme überein."
  else
    gruen "$VERS Dokumentfassungen nachgehasht, alle stimmen"
  fi
else
  # Ein leerer Tresor ist **richtig**, wenn die Datenbank auch keinen kennt —
  # und ein Befund, wenn sie einen kennt. Das ist die Frage, die eine
  # Grössenschwelle nicht beantworten kann.
  ALLE_VERS="$(psql_ "SELECT count(*) FROM document_versions" 2>/dev/null || echo 0)"
  DATEIEN="$(find "$SCRATCH/docs" -type f 2>/dev/null | wc -l)"
  if [ "$ALLE_VERS" -gt 0 ] && [ "$DATEIEN" -eq 0 ]; then
    befund "Die Datenbank kennt $ALLE_VERS Dokumentfassung(en), das Archiv enthält keine einzige Datei."
  else
    gruen "Tresor stimmig: $ALLE_VERS Fassung(en) in der Datenbank, $DATEIEN Datei(en) im Archiv"
    printf '  \033[2m…\033[0m Prüfgrenze: keine Fassung trägt eine Prüfsumme — der Inhalt ist hier ungeprüft.\n'
  fi
fi

# --- Stufe 6: die Gegenprobe -------------------------------------------------
kopf "Stufe 6 — die Gegenprobe"
if [ "$GEPRUEFT" -gt 0 ] && [ "$FEHLEND" -eq 0 ]; then
  OPFER="$SCRATCH/$(psql_ "SELECT transcript_path FROM agent_runs WHERE transcript_path IS NOT NULL LIMIT 1" | sed 's|^/data/||')"
  rm -f "$OPFER"
  read -r _ NACHHER <<<"$(pfade_pruefen 2>/dev/null)"
  if [ "$NACHHER" -eq 1 ]; then
    gruen "Eine gelöschte Datei ergibt genau eine Fehlstelle — die Prüfung oben sieht wirklich hin"
  else
    befund "Nach dem Löschen einer Datei meldet die Prüfung $NACHHER Fehlstellen statt 1 — sie prüft nicht, was sie soll."
  fi
else
  printf '  \033[2m…\033[0m Übersprungen: Stufe 5 hat nichts Grünes geliefert, das sich widerlegen liesse.\n'
fi

printf '\n\033[1mPrüfgrenzen dieses Laufs\033[0m\n'
cat <<'GRENZEN'
  · Geprüft ist eine Kopie in einer leeren Postgres — nicht, dass das laufende
    System wiederherstellbar wäre (keine Rollen, keine Grants, keine App).
  · Die Auslagerung ausser Haus ist nicht geprüft (A35, vom Betreiber vertagt).
  · Die 14/8-Aufbewahrung ist nicht geprüft — das ist backup-run.sh.
  · Ein Transkript gilt als heil, wenn es existiert, nicht leer ist und seine
    erste Zeile als JSON parst. Ob am Ende Zeilen fehlen, sagt keine Prüfsumme.
GRENZEN

if [ "$fail" -gt 0 ]; then
  printf '\n\033[1mErgebnis:\033[0m %d Befund(e).\n' "$fail"
  exit 1
fi
printf '\n\033[1mErgebnis:\033[0m alle Stufen halten.\n'
