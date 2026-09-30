-- =============================================================================
-- 0023_event_log_search — §18s Log-Explorer: Volltext über `event_log.payload`
--
-- §18 verlangt „a queryable log explorer in the dashboard (filter by
-- project/task/level/time + full-text)". Die vier Filter haben ihre Indizes seit
-- 0001; der Volltext hatte keinen.
--
-- Vier Entscheidungen, und die erste ist die, die diese Migration von 0020
-- unterscheidet.
--
--   1. **Ausdrucksindex, keine generierte Spalte.** 0020 brauchte für den Tresor
--      eine gespeicherte Spalte, weil `ts_rank` auf ihr rechnet und die
--      Relevanz die Sortierung *ist*. Hier wird nach **Zeit** sortiert (genauer:
--      nach `id`, siehe 4), der Vektor wird also nur als Prädikat gebraucht und
--      muss nirgends gelesen werden. Dazu kommt der Grund, der hier den
--      Ausschlag gibt: `event_log` ist append-only mit DENY-Triggern und §18
--      hebt sie für immer auf — eine `ADD COLUMN … GENERATED` schriebe die
--      ganze Tabelle neu, und das ist auf der einen Tabelle, die niemals
--      schrumpft, die teuerste Form, dieselbe Frage zu beantworten.
--
--   2. **`'simple'`, nicht `'german'`.** Bewusst anders als 0020, und der Grund
--      ist der Inhalt: eine Nutzlast hier besteht aus Kennungen, Zustandsnamen,
--      Zahlen und gemischt deutsch-englischer Prosa aus fremden Werkzeugen. Ein
--      Stemmer, der `finding` und `findings` zusammenzieht, faltet dieselben
--      Wörter je nach Sprache verschieden, und eine uuid gewinnt durch Stemming
--      gar nichts. `'simple'` heisst: kleinschreiben, zerlegen, sonst nichts —
--      also findet man, was man eingegeben hat.
--      **Ausdrücklich nicht gemessen** (0020s Tabelle beruht auf Messungen);
--      diese Wahl ist begründet und nicht belegt, und das gehört gesagt, weil
--      ein Migrationskopf nach dem Anwenden unveränderlich ist.
--
--   3. **`'["all"]'`, also Zeichenketten *und* Zahlen und Wahrheitswerte.** Die
--      Vorgabe von `jsonb_to_tsvector` wären nur Zeichenketten; dann fände
--      „503" den Rollout nicht, dessen Nutzlast `{"status": 503}` sagt, und
--      genau danach sucht jemand, der wissen will, warum etwas zurückgerollt
--      wurde. **Schlüssel sind nicht dabei** — sie kämen in jeder Zeile vor und
--      machten jeden Suchbegriff, der zufällig ein Feldname ist, wertlos.
--
--   4. **Die Sortierung bleibt `id DESC` und nicht `occurred_at DESC`**, obwohl
--      es für letzteres seit 0001 einen Index gibt. Der Explorer blättert über
--      eine wachsende Tabelle, und ein Offset überspringt Zeilen, während man
--      blättert; ein Cursor auf `id` kann das nicht, weil `id` streng monoton
--      und eindeutig ist. Derselbe Grund, aus dem der SSE-Nachholpfad seit
--      Phase 1 nach `id` nachholt. `occurred_at` bleibt der **Filter**.
--
-- Der Ausdruck steht hier und in `apps/server/src/log.ts` wörtlich gleich; weicht
-- einer ab, benutzt die Abfrage den Index nicht mehr — sie bleibt korrekt und
-- wird still langsam, was die unangenehmere Richtung ist. `log.test.ts` hält
-- beide gegeneinander.
-- =============================================================================

CREATE INDEX IF NOT EXISTS event_log_volltext_idx
  ON event_log USING GIN (jsonb_to_tsvector('simple', payload, '["all"]'));

COMMENT ON INDEX event_log_volltext_idx IS
  '§18 log explorer full-text over event_log.payload. Expression index: the column would rewrite an append-only table that never shrinks (0023, decision 1).';
