#!/usr/bin/env bash
# Die Betriebsprüfung (§8.2) auf dem Host, auf dem das Studio läuft.
#
#   infra/scripts/audit-remote.sh --host <ssh-host> --domain gate_truth \
#     --trigger phase_close --scope "Phase 7"
#
# ## Warum es dieses Skript gibt
#
# §8.2 lässt eine Prüfung **nach jedem Phasenabschluss** laufen, also gehört sie
# in ein wiederholbares Skript und nicht in eine Handreichung, die beim nächsten
# Mal neu hergeleitet wird (§22: „demo means a scripted, repeatable check").
#
# Am 18.8.2026 kam dazu ein zweiter Grund: **der Prüfer startet auf der
# Baumaschine nicht**, und das ist richtig so. Drei Wände, alle POSIX, und die
# dritte ist eine Zusicherung, die nicht angefasst werden darf:
#
#   1. `await import()` mit einem Windows-Pfad — behoben (A130).
#   2. `projects.root_path` verlangt einen POSIX-absoluten Pfad — behoben (A131).
#   3. `buildRoleSettings` verweigert einen Hook-Pfad mit Backslashes, mit der
#      ausgeschriebenen Begründung „Refused rather than quoted, because a quoting
#      scheme is one more thing that can be subtly wrong". Das ist §6.6, und sie
#      zu lockern, damit ein Skript auf Windows läuft, wäre §0.3s Abschwächung.
#
# A127 hat für den Gate dieselbe Frage schon beantwortet: was auf Windows nicht
# läuft, wird nicht portiert, sondern in Linux gefahren. Hier kommt hinzu, dass
# der richtige Ort ohnehin der Produktionshost ist — siehe unten.
#
# ## Was der Lauf dort besser kann als lokal
#
#   - **Das echte Ereignisprotokoll als Gegenbeleg.** §8.2s Domäne 2 fragt
#     ausdrücklich, ob eine Behauptung der Form „auf dem Produktionshost verifiziert" auf
#     einen Lauf zeigt. Gegen eine leere lokale Datenbank ist das nicht prüfbar,
#     und die Domäne verliert ihre Hälfte.
#   - **Die Funde landen im Posteingang des Betreibers.** Eine P1-Karte aus einem
#     `gate_invalid` und die P2-Aufgaben aus `coverage_gap`-Funden (A65) sind
#     dort, wo er sie sieht, statt in einer Datenbank, die nur ich kenne.
#   - **Der Token bleibt, wo er hingehört.** A5: „stored only in the claude auth
#     volume". Ihn für einen lokalen Lauf herauszutragen, widerspricht dem — und
#     das war der Grund, warum der lokale Weg auch mit Anmeldung ausschied.
#
# ## Wie
#
# Gefahren wird im **Gate-Image** (`Dockerfile.gate`), nicht im
# Orchestrator-Image: letzteres ist ein gebündeltes Artefakt (`/out/orchestrator`)
# ohne `infra/scripts`, ohne `pnpm` und ohne `packages/*/dist` in Repo-Form —
# gemessen, nicht vermutet. Das Gate-Image trägt node, pnpm, git und die gepinnte
# CLI, also genau das, was `run-audit.sh` braucht.
#
# Der Arbeitsbaum wird **eingehängt** statt hineingestreamt, und das ist der
# Unterschied zu `in-container.sh`: der Prüfbericht ist nach A56 und A92 der
# dauerhafte Teil des Nachweises, und ein `--rm`-Container ohne Einhängung nimmt
# ihn mit.
#
# Exit-Codes — die des Prüfers werden **durchgereicht**, damit der Aufrufer das
# Urteil erfährt, ohne zu parsen:
#   0  unbedenklich
#   1  funde_zu_beheben
#   3  phase_nicht_abschliessbar (ein Gate wurde entwertet)
#   2  infra — nichts geprüft (A25)
set -euo pipefail

HOST="${VORSCHICHT_HOST:-}"
REMOTE_ROOT="${VORSCHICHT_REMOTE_ROOT:-/opt/vorschicht}"
# Der Baum, der geprüft wird — normalerweise der ausgerollte.
#
# `--baum <pfad>` trennt ihn davon, und der Anlass ist eine Bedingung des Betreibers,
# die sonst unerfüllbar wäre: seine Freigabe für den Rollout lautet „nach grünem
# Gate **und grüner Prüfung**". Die Prüfung läuft aber nur hier (drei POSIX-Wände
# auf der Baumaschine, A135), also käme sie ohne diese Option immer *nach* dem
# Rollout — und prüfte damit genau das, was sie hätte freigeben sollen.
#
# Mit `--baum` wird ein frischer Auscheckstand des Kandidaten geprüft, gegen die
# **Produktionsdatenbank**: das Ereignisprotokoll bleibt der echte Gegenbeleg
# (§8.2s Domäne 2), die Funde landen in des Betreibers Posteingang, und der Baum ist der,
# über den entschieden wird. Die `.env` kommt weiterhin aus `REMOTE_ROOT` — ein
# Auscheckstand hat keine und soll keine bekommen.
PRUEF_BAUM=""
COMPOSE_NET="${VORSCHICHT_REMOTE_NET:-vorschicht_default}"
IMAGE="${VORSCHICHT_GATE_IMAGE:-vorschicht-gate:local}"
STORE_VOL="${VORSCHICHT_STORE_VOLUME:-vorschicht-audit-store}"

# Die Argumente werden unverändert an `run-audit.sh` weitergereicht. Hier wird
# nichts über sie entschieden — der Prüfer kennt seine Domänen selbst und lehnt
# eine unbekannte mit Code 2 ab.
ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:-}"; shift 2 ;;
    --baum) PRUEF_BAUM="${2:-}"; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

usage() {
  echo "  infra/scripts/audit-remote.sh --host <ssh-host> --domain gate_truth --trigger phase_close" >&2
  echo "  --host <ssh-host> ist Pflicht (oder VORSCHICHT_HOST setzen)." >&2
  echo "  optional: --baum <pfad>  (einen anderen Auscheckstand prüfen als den ausgerollten)" >&2
}

if [ -z "$HOST" ]; then
  echo "audit-remote: --host <ssh-host> fehlt." >&2
  usage
  exit 2
fi

if [ "$#" -eq 0 ]; then
  echo "audit-remote: keine Argumente — sie gehen unverändert an run-audit.sh." >&2
  usage
  exit 2
fi

[ -n "$PRUEF_BAUM" ] || PRUEF_BAUM="$REMOTE_ROOT"

vorpruefung() {
  # Jede dieser Verweigerungen ist „nichts geprüft", nicht „ein Befund" (A25/A50).
  # Ein Skript, das rot meldet, weil der Host nicht erreichbar war, erzeugt genau
  # die Fehlklassifikation, die A50 einmal quer durchs Gate-System gezogen hat.
  if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" true 2>/dev/null; then
    echo "audit-remote: „$HOST“ ist nicht per ssh erreichbar." >&2
    exit 2
  fi
}

vorpruefung

# Jeder Fernteil geht als **zitiertes** Heredoc über `bash -s --`, und alle Werte
# kommen als Positionsargumente. Der erste Anlauf hat sie in eine doppelt
# gequotete Zeichenkette interpoliert und ist an der ersten `$( )` zerbrochen —
# dieselbe Klasse wie die Heredoc-Backslashes von A131.6: Inhalt, der durch zwei
# Shells muss, wird nicht interpoliert, sondern übergeben.
echo "▶ Vorprüfung auf $HOST"
ssh -o BatchMode=yes "$HOST" bash -s -- "$REMOTE_ROOT" "$COMPOSE_NET" <<'REMOTE'
set -eu
root="$1"; net="$2"
cd "$root" 2>/dev/null || { echo "audit-remote: $root gibt es nicht." >&2; exit 2; }
command -v docker >/dev/null || { echo 'audit-remote: kein docker auf dem Host.' >&2; exit 2; }
docker network inspect "$net" >/dev/null 2>&1 || {
  echo "audit-remote: das Netz \"$net\" gibt es nicht — läuft der Stack?" >&2; exit 2; }
test -f .env || { echo "audit-remote: $root/.env fehlt." >&2; exit 2; }
# Die zwei Werte werden gelesen, nie gedruckt (§19).
grep -q '^CLAUDE_CODE_OAUTH_TOKEN=' .env || {
  echo 'audit-remote: kein CLAUDE_CODE_OAUTH_TOKEN in der .env — der Prüfer bräuchte eine Sitzung.' >&2
  exit 2; }
# `DATABASE_URL` steht **nicht** in der `.env` — `infra/docker-compose.yml:68`
# setzt sie aus `POSTGRES_USER`, `POSTGRES_PASSWORD` und `POSTGRES_DB` zusammen.
# Sie hier nachzubauen wäre eine zweite Deklaration derselben Sache, und A81 ist
# die Geschichte davon, was das kostet. Gelesen wird sie deshalb aus dem
# laufenden Orchestrator, der die einzige Quelle ist — das prüft nebenbei, dass
# der Stack läuft, was für die Datenbank ohnehin Vorbedingung ist.
docker exec vorschicht-orchestrator-1 printenv DATABASE_URL >/dev/null 2>&1 || {
  echo 'audit-remote: der Orchestrator läuft nicht oder kennt kein DATABASE_URL.' >&2
  echo '  Ohne laufenden Stack gibt es keine Datenbank, in die eine Prüfung schreiben könnte.' >&2
  exit 2; }
# Die Zeile nennt den **ausgerollten** Stand, nicht den geprüften. Bis zum
# 25.8.2026 stand hier nur „Baum auf <sha>" — bei einem Lauf mit `--baum` also
# eine sha, die mit dem Prüfgegenstand nichts zu tun hat, und A146.2 ist der
# Beleg dafür, dass genau diese Verwechslung schon einmal eine ganze Prüfung
# wertlos gemacht hat.
echo "  Ausgerollt: $(git rev-parse --short HEAD), Netz $net, Stack läuft."
REMOTE

# Und die Gegenzeile: welcher Baum wirklich geprüft wird. Sie steht getrennt,
# weil die beiden bei `--baum` auseinanderfallen — und das ist der einzige Fall,
# in dem sie überhaupt etwas sagt.
echo "  Geprüft wird: $PRUEF_BAUM ($(ssh -o BatchMode=yes "$HOST" "cd '$PRUEF_BAUM' && git rev-parse --short HEAD" 2>/dev/null || echo 'sha nicht lesbar'))"

echo "▶ Gate-Image auf $HOST bauen (nach dem ersten Mal gecacht)"
ssh -o BatchMode=yes "$HOST" bash -s -- "$PRUEF_BAUM" "$IMAGE" <<'REMOTE'
set -eu
cd "$1"
docker build -q -f infra/docker/Dockerfile.gate -t "$2" infra/docker >/dev/null
REMOTE

echo "▶ Betriebsprüfung fahren"
# `--user` mit der Kennung des Hosts, damit der Prüfbericht dem Repository
# gehört und nicht root — sonst kann der nächste git-Lauf ihn nicht anfassen,
# und das fällt erst Tage später auf (A103s Klasse).
#
# **`ssh` bewahrt keine Argumentgrenzen.** Es fügt alles, was nach dem Hostnamen
# kommt, zu **einer** Zeichenkette zusammen, und die Gegenseite zerlegt sie neu.
# Solange nur Pfade und Netznamen durchgingen, fiel das nicht auf; der erste Lauf
# mit einem echten `--scope` scheiterte mit `bash: line 1: sie: command not
# found` — der Satz enthielt ein `;`, und die entfernte Shell hat dort eine neue
# Anweisung angefangen. Ein Skript, das an einem Semikolon in einem Prosatext
# zerbricht, wäre ausserdem eine Einladung: was hier ankommt, wird drüben
# ausgeführt.
#
# `printf '%q'` erzeugt je Argument eine Form, die bash unverändert zurückliest,
# und **base64** macht daraus ein einziges Token: die gequotete Zeichenkette
# enthält selbst Leerzeichen und würde sonst genauso wieder zerfallen — der
# erste Anlauf hat genau das getan. Base64 besteht aus `A-Za-z0-9+/=` und
# übersteht jede Shell unverändert.
ARGV_B64="$(printf '%q ' "$@" | base64 | tr -d '\n')"
set +e
ssh -o BatchMode=yes "$HOST" bash -s -- \
  "$REMOTE_ROOT" "$COMPOSE_NET" "$IMAGE" "$STORE_VOL" "$PRUEF_BAUM" "$ARGV_B64" <<'REMOTE'
set -eu
root="$1"; net="$2"; image="$3"; baum="$5"; argv_b64="$6"
eval "set -- $(printf '%s' "$argv_b64" | base64 -d)"
cd "$root"
# Die einzige Quelle für die Verbindungszeichenkette ist der laufende
# Orchestrator (siehe die Begründung in der Vorprüfung). Der Token kommt aus der
# `.env`; beide bleiben auf diesem Host und werden nie gedruckt (§19).
db="$(docker exec vorschicht-orchestrator-1 printenv DATABASE_URL)"
token="$(grep '^CLAUDE_CODE_OAUTH_TOKEN=' .env | head -1 | cut -d= -f2-)"
# Das Sitzungsprotokoll der Prüfung — über ein Zwischenverzeichnis (A150).
#
# **Der Fund.** Bis zum 25.8.2026 schrieb `run-audit.mjs` die Transkripte der
# Betriebsprüfung in ein `mkdtemp` unter `/tmp`, das sein eigener `finally`-Block
# löscht: sie waren weg, sobald der Lauf fertig war, während `agent_runs`
# weiter darauf zeigte. Gefunden von `restore-probe.sh` beim ersten Lauf gegen
# den Produktionshost — zwei von sechzehn Läufen zeigten auf `/tmp/vorschicht-audit-…`.
# §6.2 verlangt „a **copy** of the session JSONL transcript into the transcripts
# volume", A14 sichert genau dieses Volume, und §8.2s Berichte verweisen auf ihre
# Sitzungen. Für das eine Departement, dessen Aufgabe die Nachprüfbarkeit ist,
# galt nichts davon.
#
# **Warum ein Zwischenverzeichnis und nicht der direkte Mount.** Ein uid-Konflikt,
# gemessen statt vermutet: `/srv/vorschicht/transcripts` gehört uid **10001** mit
# 755, dieser Container läuft nach A135.4 als der **aufrufende** Benutzer (uid
# 1000), damit der Prüfbericht dem Repository gehört und nicht root. Eine
# Kennung kann nicht beides. Also schreibt der Lauf in ein Verzeichnis, das ihm
# gehört, und danach werden die Dateien mit den richtigen Rechten hinübergelegt.
#
# **Fail closed:** klappt das Hinüberlegen nicht, sagt das Skript wohin die
# Dateien stattdessen zeigen — statt still einen Prüfbericht abzulegen, dessen
# Sitzung niemand mehr nachlesen kann.
transkripte="${VORSCHICHT_TRANSCRIPTS_DIR:-/srv/vorschicht/transcripts}"
staging="$(mktemp -d "${TMPDIR:-/tmp}/vorschicht-pruef-transkripte-XXXXXX")"

# `set +e`, weil `set -eu` oben gilt und ein Urteil von 1 oder 3 ein **gültiges
# Ergebnis** ist, kein Abbruch (die Exit-Codes stehen im Kopf). Ohne das würde
# das Skript genau dann vor dem Umzug der Protokolle sterben, wenn die Prüfung
# etwas gefunden hat — also wenn ein Bericht auf seine Sitzung verweist.
set +e
# **`</dev/null`, und ohne das lief die halbe Datei nicht (A150.10).**
#
# Der entfernte Teil kommt über `bash -s`, liest sein Skript also von **stdin**.
# `docker run -i` haengt sich an dasselbe stdin und frisst den Rest des
# Heredocs: alles nach dieser Zeile wurde nie an bash geliefert. Sichtbar wurde
# es erst, als hier ueberhaupt etwas danach stand — der Umzug der
# Sitzungsprotokolle schwieg in **beiden** Zweigen, auch in dem, der „kein
# Protokoll gefunden" meldet. Eine Zeile, die nicht ausgefuehrt wird, sieht
# genauso aus wie eine, deren Bedingung nicht zutraf.
#
# `-i` faellt weg statt umgeleitet zu werden: der Lauf liest nichts von stdin,
# und ein `-i`, das nur noch da ist, weil es immer da war, ist genau die tote
# Verdrahtung, die §8.2s sechste Domaene sucht.
docker run --rm </dev/null \
  --network "$net" \
  --user "$(id -u):$(id -g)" \
  -v "$baum":/work \
  -v "$staging":/data/transcripts \
  -w /work \
  -e HOME=/tmp \
  -e CI=true \
  -e DATABASE_URL="$db" \
  -e CLAUDE_CODE_OAUTH_TOKEN="$token" \
  -e VORSCHICHT_TRANSCRIPTS_ROOT=/data/transcripts \
  "$image" \
  bash -euo pipefail -c '
    # **Ohne lesbare Historie wird nicht geprüft.** Fund 5 der Prüfung 2150e493
    # (18.8.2026), und sie hat ihn an sich selbst gemacht: der Prüfbaum war ein
    # `git clone --shared`, seine Objekte lagen über `alternates` in
    # `/opt/vorschicht/.git/objects` — einem Pfad, den dieser Container nicht
    # eingehängt hat. `git log` scheiterte, der Kandidatenpool war **leer**, und
    # der Lauf startete trotzdem. Ihr eigener Satz dazu: er „hätte ein Urteil
    # abgegeben, das von einer echten Entlastung nicht zu unterscheiden gewesen
    # wäre".
    #
    # Das ist §8.2s sechste Domäne am Prüfer selbst, und die Antwort ist A25s:
    # nichts geprüft ist keine Feststellung, also Exit 2 statt eines Urteils.
    # `git rev-parse HEAD` taugt dafür **nicht**, gemessen statt vermutet: bei
    # einem abgelösten HEAD liest es die Datei `.git/HEAD` und braucht kein
    # einziges Objekt — es antwortete auf genau dem kaputten Baum mit `9631b3d`
    # und Exit 0. Der erste Entwurf dieses Riegels stand damit für sich selbst
    # als Beispiel. Was trägt, ist ein Kommando, das ein Objekt **liest**:
    # `git log` (und `git cat-file -e HEAD`) scheitern beide, `rev-parse` nicht.
    # Genommen ist `git log`, weil der Sammler dieser Domäne genau das fährt.
    if ! git log -1 --format=%H >/dev/null 2>&1; then
      echo "audit-remote: die git-Historie des Prüfbaums ist hier nicht lesbar." >&2
      git log -1 --format=%H 2>&1 | sed "s/^/  /" >&2
      echo "  Ohne sie ist die Domäne claim_vs_evidence gegenstandslos: Commit-Nachrichten" >&2
      echo "  sind ihr Gegenstand. Der Baum muss seine Objekte selbst tragen —" >&2
      echo "  git clone --no-local statt --shared." >&2
      exit 2
    fi

    # Kein geteiltes Store-Volume, und das ist eine Entscheidung: es gehörte dem
    # Standardbenutzer des Images (10001), während dieser Lauf als der
    # Host-Benutzer läuft — damit der Prüfbericht dem Repository gehört und nicht
    # root (A103s Klasse). Statt einer Rechte-Akrobatik landet der Store unter
    # HOME im Container. Das kostet knapp eine Minute je Lauf und nimmt eine
    # geteilte Ressource aus dem Spiel, die sonst zwischen zwei Benutzern
    # vermittelt werden müsste.
    # **Ein gescheiterter Aufbau ist Exit 2, kein Urteil (A150.9).**
    #
    # Gemessen am 25.8.2026: `pnpm install` scheiterte im Container, weil
    # corepack den Download seiner eigenen pnpm-Fassung bestätigt haben will und
    # ohne Terminal abbricht. Der Container endete mit **1** — und 1 ist zugleich
    # `run-audit.sh`s Urteil `funde_zu_beheben`. Das Skript meldete also
    # „Urteil: funde_zu_beheben“ über eine Prüfung, die **nie gelaufen ist**;
    # `audits` bekam keine Zeile, und niemand hätte es gemerkt.
    #
    # Das ist die Fehlklassifikation, vor der der Kopf dieser Datei warnt, am
    # Prüfer selbst — §8.2s sechste Domäne, zum zweiten Mal in diesem Block.
    # `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` behebt die Ursache; die Verzweigung
    # darunter behebt die Klasse, denn der nächste Aufbaufehler wird ein anderer
    # sein.
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    if ! pnpm install --frozen-lockfile --reporter=silent; then
      echo "audit-remote: pnpm install ist gescheitert — nichts geprüft (A25)." >&2
      exit 2
    fi
    # `--force`, und der Grund ist gemessen. `pnpm -r --if-present build` fährt
    # in jedem Paket `tsc --build`, und das **traut den Zeitstempeln**: der
    # Prüfbaum ist ein Mount, der die `.tsbuildinfo` eines früheren Laufs trägt,
    # während `dist/` daneben aus einem anderen Stand stammt. Am 25.8.2026 sah
    # das so aus, dass `@vorschicht/shared` übersprungen wurde und `apps/server`
    # danach acht Mal „has no exported member" meldete — ein Bau, der an einem
    # Artefakt scheitert statt am Baum. A90.7 hat dieselbe Falle für
    # `demo-phase5.sh` beschrieben: „tsc --build trusts timestamps, and that is
    # precisely the assumption that must not carry here."
    #
    # Gebaut wird mit `tsc --build --force` an der Wurzel und **nicht** mit
    # `pnpm -r build`: der Prüfer importiert `packages/{shared,core,db}/dist`,
    # und die deckt die Projektverweiskette vollständig ab. `pnpm -r` reichte
    # `--force` zusätzlich an `apps/web` weiter, dessen Bau `vite build` ist und
    # daran scheitert — eine PWA, die dieser Lauf nie anfasst.
    if ! pnpm exec tsc --build --force; then
      echo "audit-remote: der Bau ist gescheitert — nichts geprüft (A25)." >&2
      exit 2
    fi
    exec bash infra/scripts/run-audit.sh "$@"
  ' audit-remote "$@"
urteil=$?
set -e

# Die Sitzungsprotokolle ins Volume legen (A150.7).
#
# `set -eu` gilt hier, deshalb steht `urteil` oben und wird unten wieder
# durchgereicht: die Protokolle gehören auch dann ins Volume, wenn die Prüfung
# Funde gemeldet hat — gerade dann, denn dann verweist ein Bericht auf sie.
#
# `sudo -n`: klappt es nicht, wird es **gesagt** und der Pfad genannt, statt
# einen Prüfbericht abzulegen, dessen Sitzung niemand mehr nachlesen kann. Die
# Dateien bleiben dann im Zwischenverzeichnis liegen (kein `rm`), damit ein
# Mensch sie holen kann.
if [ -n "$(find "$staging" -type f -name '*.jsonl' 2>/dev/null | head -1)" ]; then
  if sudo -n cp -a "$staging"/. "$transkripte"/ 2>/dev/null \
     && sudo -n chown -R 10001:10001 "$transkripte" 2>/dev/null; then
    echo "  Sitzungsprotokoll(e) nach $transkripte gelegt (§6.2, A14)."
    rm -rf "$staging"
  else
    echo "  ! Die Sitzungsprotokolle konnten nicht nach $transkripte gelegt werden." >&2
    echo "  ! Sie liegen in $staging und sind NICHT gesichert (§6.2, A14, A150.6)." >&2
    echo "  ! Von Hand: sudo cp -a $staging/. $transkripte/ && sudo chown -R 10001:10001 $transkripte" >&2
  fi
else
  echo "  ! Der Lauf hat kein Sitzungsprotokoll hinterlassen — das ist selbst ein Befund (§6.2)." >&2
  rm -rf "$staging"
fi

exit "$urteil"
REMOTE
URTEIL=$?
set -e

echo
case "$URTEIL" in
  0) echo "Urteil: unbedenklich" ;;
  1) echo "Urteil: funde_zu_beheben" ;;
  3) echo "Urteil: phase_nicht_abschliessbar — ein Gate ist entwertet" ;;
  2) echo "Nichts geprüft (infra) — kein Befund, keine Entwarnung (A25)" ;;
  *) echo "Unerwarteter Code $URTEIL" ;;
esac

if [ "$URTEIL" != 2 ]; then
  echo
  echo "▶ Prüfberichte auf dem Host (der dauerhafte Teil des Nachweises, A56/A92):"
  ssh -o BatchMode=yes "$HOST" "ls -1t '$REMOTE_ROOT'/docs/pruefberichte/ | head -3" || true
  echo "  Holen mit: ssh $HOST cat $REMOTE_ROOT/docs/pruefberichte/<datei> > docs/pruefberichte/<datei>"
fi

exit "$URTEIL"
