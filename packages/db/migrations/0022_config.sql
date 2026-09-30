-- =============================================================================
-- 0022_config — §5's `config` entity, and the first setting to live in it: how
-- much of §8's persona layer is switched on.
--
-- §5 lists `config` / `personas` as one mandatory entity covering "plan
-- profile, concurrency, model mapping, backend selection, Sparbetrieb, persona
-- settings, notification settings". This migration builds the table and one
-- key. The rest arrive as keys, not as tables.
--
-- Five decisions.
--
--   1. **Mutable, and that is the same call 0020 made and the opposite of the
--      one 0021 made one file earlier.** The rule those two established is not
--      "is it configuration" but *does this entity have a history somebody will
--      have to reconstruct*. A source's level is the evidence behind a legal
--      citation, so its history is the point (0021 decision 1). A switch the operator
--      flips has no such reconstruction: the question anybody asks of it later
--      is "who changed this, when, and from what", and §19 answers exactly that
--      in `audit_log` — with `before` and `after` per row, which is the shape
--      `ProjectService.audit` and `SourceAuditLog` already write.
--
--      §5 also settles it in as many words: "append-only / event-sourced
--      wherever state history matters. **Mutable tables only for pure
--      configuration.**" This is the row that sentence was written for, and it
--      is therefore deliberately **not** in `packages/db/append-only.json`.
--
--   2. **Key/value, not a column per setting.** A `config` table with a column
--      per knob would need a migration for every future setting — concurrency,
--      model mapping, Sparbetrieb, notification settings — and §5 names six
--      more that are coming. Worse, it would need a single row plus a rule
--      that keeps it single, and "exactly one row" is a constraint nobody
--      writes and everybody assumes. One key per setting, primary key on the
--      key, and the absence of a row is a real answer: the default.
--
--   3. **The default lives in code, not in a seeded row.** Nothing is inserted
--      here. A seeded row would make "the operator has never touched this" and "the operator set
--      it back to the default" indistinguishable, and it would put the default
--      in two places — this file, which is frozen the moment it is applied, and
--      the TypeScript that has to know it anyway for the case where the row is
--      missing. `PersonaSettings` reads a missing row as `PERSONA_MODE_DEFAULT`.
--
--   4. **`jsonb`, so a setting can grow without a migration.** Today's value is
--      one string. Concurrency will be a number, the model mapping an object.
--      A `text` column would force either a second column later or a parsing
--      convention nobody declared; `jsonb` costs nothing here and the service
--      validates the shape with zod on the way in and on the way out — the
--      boundary rule §3 states for every other input.
--
--   5. **No `_no_truncate` guard, and that is not an omission.** The guards in
--      0004 exist for the tables §18 keeps forever. Truncating `config` loses
--      the operator's switch positions and costs him one visit to the settings page; it
--      loses no history, because the history is in `audit_log`, which does have
--      the guard. Recorded because A100.7 filed a `coverage_gap` about exactly
--      this class of trigger and the next reader should see that the absence
--      was decided rather than forgotten.
-- =============================================================================

CREATE TABLE config (
  key        text PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE config IS
  '§5''s configuration entity. Mutable by design; §19''s audit_log carries who changed what, when, and from which value.';

-- DELETE is granted where 0001 grants it for `projects`: a setting that can be
-- created and changed but never removed would make "back to the default" a
-- state the app cannot express, and the default is the one value with no row.
GRANT SELECT, INSERT, UPDATE, DELETE ON config TO vorschicht_app;
