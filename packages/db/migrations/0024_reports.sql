-- =============================================================================
-- 0024_reports — §5s `reports`-Entität: das Archiv von §16s Wochenbericht.
--
-- **Nicht `build_reports` aus 0007.** Das ist der Fortschritt der *Bauschleife*,
-- von `report-build.mjs` geschrieben, damit der Betreiber den Baufortschritt im Dashboard
-- sieht. Hier geht es um den Wochenbericht, den §16 montags um 07:00
-- Europe/Vienna per Mail schickt und im Dashboard archiviert. Zwei Tabellen,
-- zwei Gegenstände, ein ähnlicher Name — deshalb steht der Unterschied hier
-- oben und nicht in einer Fussnote.
--
-- Fünf Entscheidungen. Die erste ist die, für die dieses Schema zwei
-- ausdrücklich entgegengesetzte Präzedenzfälle hat.
--
--   1. **Append-only, und zwar als schlichte Tabelle: weder mutabel wie 0020
--      und 0022 noch als Ereignis-Log mit View wie 0021.**
--
--      Die Regel, die 0021 und 0022 aufgestellt haben, lautet nicht „ist es
--      Konfiguration", sondern *hat diese Entität einen Verlauf, den jemand
--      rekonstruieren muss*. Ein Wochenbericht hat keinen: er entsteht einmal,
--      für ein festes Fenster, und nichts revidiert ihn danach. Es gibt kein
--      „angenommen", kein „hochgestuft", kein „stillgelegt" — die Zustände, die
--      bei einer Quelle (0021) den Ausschlag gaben. Ein Ereignis-Log trüge hier
--      also genau eine Ereignisart, und die View wäre `SELECT *` mit
--      Zwischenschritten. Das ist wörtlich 0015s erste Entscheidung für
--      `gate_runs`, und aus demselben Grund.
--
--      Bleibt die Frage mutabel gegen append-only, und die entscheidet §22s
--      Phase-8-Gate: „Spot audit: every headline number reconciles with the
--      event log via an audit script." Ein Archiv, das sich ändern lässt, ist
--      gegen nichts abgleichbar — eine Abweichung zwischen Bericht und
--      Ereignisprotokoll wäre von einer späteren Korrektur nicht zu
--      unterscheiden, und genau diese Unterscheidung *ist* die Prüfung. Dazu
--      kommt, was ein Wochenbericht ist: eine Mail, die der Betreiber bekommen hat. Die
--      Zeile ist der Beleg dafür, was ihm gesagt wurde, und ein System, das
--      seine eigenen Aussagen über sich nachträglich umschreiben kann, ist
--      §8.2s Gegenstand. 0020s Argument für eine mutable Tabelle trägt hier
--      nicht: dort war die Änderung ein Umtaggen, dessen Verlauf `audit_log`
--      ohnehin führt; hier gäbe es keine Änderung, die jemand vornehmen dürfte.
--
--   2. **Die Kennzahlen liegen strukturiert *neben* dem gerenderten Text, und
--      beides ist nötig, weil es zwei verschiedene Fragen beantwortet.**
--
--      `metrics` ist die **Behauptung**: §16s Kopfzahlen (erledigte Aufgaben,
--      Merges, Deployments samt Rollbacks, Gate-Bestehensquote,
--      Budgetauslastung je Fenster, beantwortete und offene Eskalationen). Sie
--      liegen als jsonb da, damit §22s Prüfskript sie unabhängig aus
--      `event_log` nachrechnen und gegen die *gespeicherte* Zahl halten kann.
--      Läge nur der Text vor, müsste dieses Skript deutsche Prosa parsen, um an
--      die Zahlen zu kommen — dann ist der Bericht ein Bild und kein Datum, und
--      das Gate prüft die Regex statt der Rechnung.
--
--      `body_text`, `body_html` und `subject` sind der **ausgelieferte
--      Gegenstand**. §16 verlangt HTML und Klartext, und das Phase-8-Gate
--      verlangt beide „verified". Ein Archiv, das nur die Zahlen hält und den
--      Text bei Bedarf neu rendert, beantwortet die Frage „was hat der Betreiber
--      eigentlich gelesen" mit einem Rendering aus der Vorlage von *heute* —
--      und das ist nicht, was im Februar rausging. Deshalb auch `subject`: er
--      gehört zur Mail, und ihn später aus einer Vorlage zu rekonstruieren ist
--      dasselbe Problem eine Zeile höher. Er trägt doppelt, weil die
--      Archivliste (§17) damit eine Überschrift hat, ohne zwei vollständige
--      Dokumente je Zeile laden zu müssen.
--
--      Ausdrücklich **nicht** gespeichert: die sechs Abschnitte aus §16
--      einzeln. Der Text wird aus ihnen gerendert; beides abzulegen wären zwei
--      Darstellungen einer Sache, die auseinanderlaufen können (A81). Dass die
--      Struktur stimmt, prüft das Gate am gerenderten Text.
--
--   3. **Das Fenster sind zwei Zeitpunkte, halboffen `[start, end)`, und das
--      ist wegen der Sommerzeit keine Formalie.**
--
--      Eine Woche in Europe/Vienna hat **167 oder 169 Stunden**, nicht immer
--      168: die Umstellung im März verkürzt sie, die im Oktober verlängert sie.
--      Wer das Fenster als Datum plus „sieben Tage" ablegt, zählt an genau
--      diesen beiden Wochen falsch — im März fehlt eine Stunde Ereignisse, im
--      Oktober werden sechzig Minuten doppelt gezählt, und beides fällt in
--      einem Bericht auf, den niemand nachrechnet, überhaupt nicht auf. Zwei
--      `timestamptz` sind Zeitpunkte; die Dauer dazwischen ist, was sie ist,
--      und **nirgends darf `interval '7 days'` an ihre Stelle treten.**
--
--      Halboffen, weil ein Montag sonst zu zwei Berichten gehört. Ein
--      Ereignis genau auf `period_end` zählt zur *nächsten* Woche.
--
--      Zwei schärfere CHECKs wurden erwogen und verworfen, beide aus demselben
--      Grund: ein Migrationskopf ist nach dem Anwenden unveränderlich (A107.4),
--      eine hier festgeschriebene Zahl also für immer festgeschrieben. Ein
--      CHECK auf „Montag 00:00 Europe/Vienna" fängt zwar genau die Klasse
--      Fehler, um die es oben geht — verbietet aber die erste, unvollständige
--      Woche einer frischen Installation und jede spätere Änderung an §16s
--      Kadenz. Ein CHECK auf „zwischen 167 und 169 Stunden" tut dasselbe. Es
--      bleibt die eine Bedingung, die unter jeder Kadenz gilt.
--
--   4. **Ein Bericht je Fenster, durchgesetzt vom Index und nicht vom Dienst.**
--
--      `reports_one_per_period` ist A77.8s Aufteilung: der Dienst ist die
--      freundliche Hälfte und liefert den deutschen Satz, der Index ist die,
--      um die ein zweiter Schreiber mit eigener Transaktion nicht herumkommt.
--      Der Ablaufplaner ist ein Tick (A57), ein Neustart mitten im
--      Montagmorgen ist also der Normalfall und kein Randfall — und ein
--      doppelter Bericht heisst zwei Mails und ein Archiv, das dieselbe Woche
--      zweimal zählt.
--
--      Der Preis, ausgesprochen statt entdeckt: eine Woche, deren Bericht aus
--      falschen Zahlen entstand, lässt sich **nicht** ersetzen. Das ist die
--      richtige Richtung — das Archiv sagt, was berichtet wurde, nicht was
--      hätte berichtet werden sollen —, aber es heisst, dass eine Korrektur
--      eine eigene Entscheidung braucht (eine zweite Zeile mit eigener
--      Kennzeichnung, oder eine Notiz im Ereignisprotokoll). Eine
--      `revision`-Spalte wurde erwogen und **nicht** gebaut: ohne Erzeuger
--      wäre sie eine Spalte mit genau einem Wert, und sobald ein Dienst sie
--      selbst hochzählt, wandert die Garantie aus dem Index zurück in den
--      Code, den sie ersetzen sollte.
--
--   5. **Was hier bewusst nicht steht.**
--
--      *Kein Zustellungsstatus.* Ob die Mail rausging, ist eine Tatsache über
--      den Versand und nicht über den Bericht — und eine append-only-Zeile
--      könnte sie ohnehin nicht nachtragen. §18s Ereignisprotokoll trägt sie,
--      wie A103.5 es für den Backup-Lauf und A86.4 für den ntfy-Push
--      entschieden haben. Die Zeile entsteht, sobald der Bericht *existiert*,
--      unabhängig davon, ob SMTP erreichbar war: auf dem Produktionshost ist heute kein
--      `SMTP_HOST` gesetzt, „erzeugt, nicht zugestellt" ist also der
--      Normalzustand, und ein Archiv, das ihn nicht darstellen kann, behauptet
--      eine Zustellung, die es nie gab.
--
--      *Keine `run_id`.* §18s Nachverfolgbarkeitskette läuft über `event_log`,
--      und dessen Zeile trägt die Kennung der Sitzung, falls eine den Text
--      geschrieben hat. Eine zweite Stelle für dieselbe Verknüpfung wäre A81s
--      Defekt.
--
--      *Keine Längengrenze als CHECK.* §16s harte Grenze ist eine Politik, die
--      §22s Phase-8-Gate ausdrücklich prüft („Length cap enforced (test with
--      padded data)"). Sie gehört zum Generator, wo sie sich ändern lässt; hier
--      wäre sie eine Zahl, die niemand mehr revidieren kann.
--
--      *Keine `kind`-Spalte.* §8.2 sagt, der Prüfbericht werde „archived with
--      `reports`". Sein strukturiertes Archiv ist heute `audits` /
--      `audit_findings` (0013, 0018) und seine dauerhafte Prosa die
--      eingecheckte Datei unter `docs/pruefberichte/` (A56, A92) — er braucht
--      hier also keine Zeile. Käme er je hierher, bräuchte er einen anderen
--      Eindeutigkeitsschlüssel (die Prüfungs-Kennung statt eines Fensters, denn
--      es kann zwei Prüfungen in einer Woche geben) und ein Urteilsfeld; das
--      ist eine Migration und keine Spalte, die heute nur einen Wert trägt.
--
--      *Kein `project_id`.* §16s Wochenbericht ist studioweit; die
--      projektweisen Punkte sind ein Abschnitt *in* ihm.
-- =============================================================================

CREATE TABLE IF NOT EXISTS reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Das Berichtsfenster als Zeitpunkte, halboffen (Entscheidung 3).
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL,

  -- Wann der Bericht entstand — nicht dasselbe wie `period_end`. Ein Bericht,
  -- den der Daemon erst am Dienstag erzeugt hat, weil er montags stand, ist
  -- eine Tatsache, die man später wissen will.
  generated_at  timestamptz NOT NULL DEFAULT now(),

  -- Der ausgelieferte Gegenstand (Entscheidung 2).
  subject       text NOT NULL,
  body_text     text NOT NULL,
  body_html     text NOT NULL,

  -- Die Behauptung (Entscheidung 2). Die Form gehört dem Modul, das die
  -- Kennzahlen erhebt; hier ist sie bewusst undurchsichtig, damit sie nicht an
  -- zwei Stellen deklariert wird.
  metrics       jsonb NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT reports_period_ordered CHECK (period_end > period_start),
  CONSTRAINT reports_metrics_is_object CHECK (jsonb_typeof(metrics) = 'object'),
  -- Ein Bericht ohne Text ist ein Defekt im Generator und keine leere Woche;
  -- §16 verlangt beide Darstellungen.
  CONSTRAINT reports_body_present CHECK (
    subject <> '' AND body_text <> '' AND body_html <> ''
  ),
  -- Entscheidung 4. Benannt statt automatisch benannt, damit der Dienst den
  -- Namen zitieren kann, ohne ihn zu raten.
  CONSTRAINT reports_one_per_period UNIQUE (period_start)
);

-- Kein zusätzlicher Index: `reports_one_per_period` legt einen btree über
-- `period_start` an, und den liest ein `ORDER BY period_start DESC` rückwärts.
-- Die Archivliste (§17) ist damit bedient.

CREATE OR REPLACE TRIGGER reports_append_only
  BEFORE UPDATE OR DELETE ON reports
  FOR EACH ROW EXECUTE FUNCTION vorschicht_deny_mutation();

-- TRUNCATE löst keinen Zeilen-Trigger aus — die Lücke, für die 0004 existiert.
-- Ausgeschrieben statt in einer Schleife, weil `gate:migrations` reguläre
-- Ausdrücke über den SQL-Text laufen lässt und eine `DO $$ … FOREACH`-Schleife
-- für ihn unsichtbar ist (A107).
CREATE OR REPLACE TRIGGER reports_no_truncate
  BEFORE TRUNCATE ON reports
  FOR EACH STATEMENT EXECUTE FUNCTION vorschicht_deny_truncate();

COMMENT ON TABLE reports IS
  'Die §5-Entität reports: ein append-only Archiv von §16s Wochenbericht — die Kennzahlen als jsonb zum Nachrechnen, der gerenderte Text als Beleg dessen, was ausgeliefert wurde.';

GRANT SELECT, INSERT ON reports TO vorschicht_app;
REVOKE UPDATE, DELETE, TRUNCATE ON reports FROM vorschicht_app;
