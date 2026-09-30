#!/usr/bin/env bash
# Die Browserstrecke als Gate-Schritt (A122).
#
# Exit-Codes nach A25/A50: **2** heisst „nichts geprüft" — kein Docker, keine
# Browser installiert, kein Port frei —, **1** heisst „ein Browserfall ist rot".
# Ein Rechner ohne Browser darf keinen Befund melden; er hat nichts gesehen.
set -uo pipefail
cd "$(dirname "$0")/../.."

# Docker braucht dieser Schritt nur, um sich selbst eine Postgres zu starten.
# Ist schon eine da, ist die Frage gegenstandslos — `with-test-db.sh` nimmt sie
# unten an, und `in-container.sh` reicht sie genau so herein (A127). Ohne diese
# Zeile meldet die Strecke im Gate-Container „nichts geprüft", obwohl eine
# Datenbank bereitsteht: ein Schritt, der wegen eines Werkzeugs schweigt, das er
# gar nicht braucht.
if [ -z "${VORSCHICHT_TEST_DB_URL:-}" ] && ! docker info >/dev/null 2>&1; then
  echo "gate:e2e — Docker ist nicht erreichbar; die Strecke braucht eine echte Postgres. Nichts geprüft (A25)." >&2
  exit 2
fi

if [ ! -d "$HOME/.cache/ms-playwright" ] && [ ! -d /ms-playwright ]; then
  echo "gate:e2e — kein Playwright-Browser installiert (pnpm exec playwright install chromium). Nichts geprüft (A25)." >&2
  exit 2
fi

# **Der Baum, nicht das letzte Artefakt.**
#
# `playwright.config.ts` startet `node apps/server/dist/main.js` und liefert den
# gebauten Bundle aus (A120). Ohne diese Zeile prüft die Strecke also, was
# zuletzt gebaut wurde — und das ist nicht „nichts geprüft", sondern schlimmer:
# der Lauf läuft durch und macht eine Aussage über ein fremdes Artefakt. Am
# 5.9.2026 gemessen, als drei neue Fälle gegen einen Server liefen, dessen Route
# es dort noch gar nicht gab: „did not find some options", eine Stunde Suche am
# falschen Ende. A90.7 nennt denselben Fall für die Demo-Skripte „schlimmer als
# nutzlos", und A140 hat die Lücke hier schon einmal benannt, ohne sie zu
# schliessen.
#
# Inkrementell, also im vollen Gate-Lauf (wo `build` ohnehin vorher läuft) ein
# No-op von unter einer Sekunde. Scheitert der Bau, ist das **2**: ein Baum, der
# sich nicht übersetzen lässt, wurde von dieser Strecke nicht geprüft, und
# `typecheck` und `build` sagen dazu Genaueres als ein roter Browserfall.
if ! bauprotokoll=$(pnpm run --silent gate:build 2>&1); then
  printf '%s\n' "$bauprotokoll" >&2
  echo "gate:e2e — der Baum liess sich nicht bauen; die Strecke prüfte sonst ein altes Artefakt. Nichts geprüft (A25)." >&2
  exit 2
fi

# Eine bereitgestellte Datenbank ist geteilt und schon benutzt; die Strecke
# braucht aber eine leere (`global-setup.ts` nennt sie „throwaway"). Der Wrapper
# legt eine eigene an und raeumt sie weg. Ohne ihn wurde ein Browserfall rot,
# weil aeltere Coder-Laeufe aus den Integrationstests die Sitzreihenfolge
# verschoben hatten — siehe `e2e-db.mjs`.
# Argumente werden durchgereicht. Bis zum 25.8.2026 nicht: ein Aufruf mit
# `--project=berichte` fuhr stillschweigend die **ganze** Strecke, also 97 Fälle
# statt 6 — und wer die Bilanz las, hielt das Ergebnis für eine Aussage über
# sein Projekt. `demo-phase8.sh` nennt genau diesen Aufruf in seiner Begründung.
if [ -n "${VORSCHICHT_TEST_DB_URL:-}" ]; then
  out=$(./infra/scripts/with-test-db.sh node infra/scripts/e2e-db.mjs pnpm exec playwright test "$@" 2>&1)
else
  out=$(./infra/scripts/with-test-db.sh pnpm exec playwright test "$@" 2>&1)
fi
code=$?
printf '%s\n' "$out"

if [ "$code" -ne 0 ]; then
  # Ein Aufbau, der gar nicht startete, ist keine Feststellung über den Code.
  # `EADDRINUSE` und „was not able to start" sind Nodes **rohe** Meldung für
  # denselben Fall, den Playwright sonst als „is already used" erkennt — am
  # 25.8.2026 gemessen, als ein Vorlauf den Port noch hielt und die Demo dafür
  # **rot** meldete statt „nichts geprüft". Das ist A25s Fehlklassifikation, und
  # A125 hat sie eine Ebene höher schon einmal behoben.
  if printf '%s' "$out" | grep -qiE "is already used|EADDRINUSE|was not able to start|ECONNREFUSED.*webServer|Executable doesn't exist|Timed out waiting .* from config.webServer"; then
    echo "gate:e2e — der Aufbau kam nicht zustande (Port belegt, Server nicht erreichbar oder Browser fehlt). Nichts geprüft (A25)." >&2
    exit 2
  fi
fi
exit "$code"
