-- =============================================================================
-- 0020_vault — §13's document vault: `documents` and `document_versions`.
--
-- §5 names both entities in one breath ("file metadata, department tags, free
-- tags, extracted text (FTS), append-only versions"), and §13 says which half
-- is which: "versions are append-only". Nine decisions here are not
-- transcription of either.
--
--   1. **`documents` is mutable, `document_versions` is append-only** — and
--      that asymmetry is the whole shape of this migration. §13 makes *only*
--      the versions append-only, and it says what governs the other half:
--      writes happen "only through the dashboard or Doris's curation flow
--      **with audit log**". That is word for word the class 0001 describes for
--      `projects` — "pure configuration, therefore mutable (§5); every change
--      is written to audit_log". Re-tagging a Statut is not a new version of
--      it, and A43's event-log treatment was considered and declined for the
--      same reason 0015 declined it for `gate_runs`: the history a tag change
--      has is the one `audit_log` already keeps, and a second log of it would
--      be two records of one fact that can disagree. The cost of being wrong
--      here is bounded and visible — a tag history that has to be read out of
--      `audit_log` rather than out of a view.
--
--   2. **The full-text index hangs off the version, never off the document.**
--      The extracted text is what *this upload* said; a document that has been
--      amended twice has three texts and only one of them is current. Putting
--      the tsvector on `documents` would have meant choosing which one the
--      column holds, and every answer to that is a rule somebody has to
--      maintain by hand on every upload.
--
--   3. **A `GENERATED ALWAYS … STORED` column plus GIN, with no extension.**
--      This is the first full-text index in this schema, so it sets the
--      precedent rather than following one. Two alternatives were discarded.
--      A `MATERIALIZED VIEW` would need `REFRESH` — a mutation this schema has
--      nowhere else, and one that would have to be scheduled, monitored and
--      recovered from; the generated column is maintained by the same
--      transaction that writes the row, so it cannot lag. An extension
--      (`unaccent`, `pg_trgm`) would buy fuzzier matching and cost a
--      deployment prerequisite nothing else here has: `vorschicht_app` is not
--      a superuser, so `CREATE EXTENSION` would have to run as the owner
--      before the first migration, and A14's restore drill would have to know
--      that. `to_tsvector` is built in and needs neither.
--
--   4. **`'german'`, not `'simple'`, and the normalisation it buys is
--      partial.** The corpus §13 names is Vereinsstatuten, AVVs and Verträge,
--      so a search for "Kündigungen" has to find a document that says
--      "Kündigung". Measured against this Postgres rather than assumed, which
--      matters because this header cannot be edited once the migration has
--      been applied. Each row is a search term put to a document carrying only
--      the *other* form, because a document that contains both would only
--      show that a word finds itself:
--
--        "Kündigungen" finds a document saying "Kündigung"          yes
--        "Kündigung"   finds a document saying "Kündigungen"        yes
--        "Auflösungen" finds a document saying "Auflösung"          yes
--        "Vertrag"     finds a document saying "Verträge"           yes
--        "Vorstand"    finds a document saying "Vorstände"          yes
--        "Kündigung"   finds a document saying "gekündigt"          NO
--        "gekündigt"   finds a document saying "Kündigung"          NO
--        "beschließen" finds a document saying "beschließt"         NO
--
--      So: noun inflection yes, verb forms and derivations across word class
--      no — the snowball stemmer strips suffixes and neither strips the `ge-`
--      participle prefix (`gekündigt` → `gekundigt`, beside `kundig`) nor
--      relates a verb to its noun. Stated here as a limit rather than
--      discovered later by whoever builds the search box: a lawyer searching
--      "gekündigt" will not find "Kündigung", and closing that gap needs a
--      dictionary, not a configuration change. `'simple'` would give up even
--      the half that works, on the majority case. Verified from the other
--      side too: with `'simple'` on both the column and the query, exactly the
--      inflection test goes red and nothing else does. A second stated
--      price: an English or Italian document is stemmed by the wrong
--      rules and ranks worse than it should. A per-document language would
--      need a per-row `regconfig` in the generated expression, which
--      PostgreSQL refuses (the configuration must be a constant for the
--      expression to be immutable) — so it would mean one column per
--      language, and that is a decision to take when a second language
--      actually arrives.
--
--   5. **`extracted_text` is nullable, and — because the version is
--      append-only — it can only ever be written when the row is inserted.**
--      NULL means "nobody has read this file yet", which is the honest state
--      today: extraction is a later block and there is no extractor. The
--      consequence is deliberate and needs saying, because it constrains
--      whoever builds that block: the guard trigger below refuses UPDATE for
--      everyone, owner included, so text cannot be back-filled into an
--      existing row. Extraction therefore belongs *before* the insert — the
--      service takes the text as an argument for exactly that reason. If a
--      later block needs extraction to be asynchronous or re-runnable (a
--      better PDF parser over files already stored), the shape that fits is a
--      companion append-only table keyed by version id, appended once per
--      extraction with the newest winning. That is a schema decision for
--      whoever needs it and is deliberately not pre-empted here; what is
--      pre-empted is the tempting one — a narrowed guard that permits "just
--      this one" UPDATE — because a guard with an exception is a guard nobody
--      can quote.
--
--   6. **`storage_path` is relative to the docs volume, and says so in a
--      CHECK.** A2 makes the volume root env-configurable and A14 restores it
--      somewhere else during the drill; an absolute path would bake today's
--      mount point into every row and point the whole vault at a directory
--      that does not exist. The path is later joined onto that root and handed
--      to the filesystem, so `..` is refused at the door for the reason A87.7
--      gives one subsystem over: a traversal in a stored string is a read
--      outside the volume, and the cheapest place to refuse it is before it is
--      stored.
--
--   7. **No `kind = 'link'`.** §13's link entries ("Vereinsgesetz on RIS") are
--      real and they are not this block: they have no file, no bytes and no
--      extracted text, so every column and every join below would become
--      optional for a case nothing yet produces — and §13 sends them onward
--      into §14's source registry, which is where their trust level lives.
--      Half-building them would leave a `kind` column with one value and a
--      nullable `storage_path` that nothing ever sets, which is §8.2's sixth
--      domain wearing a helpful face.
--
--   8. **No index on the tag arrays.** The department boost (§13's "ranking
--      boosts documents tagged for the requesting department") is a *ranking*
--      expression evaluated over the rows the full-text index already chose —
--      it is not an access path, so a GIN index on `department_tags` would be
--      an index with no reader. When a later block adds "show me everything
--      tagged Recht", it adds the index together with the query that uses it.
--      The containment is written as `@>` rather than `= ANY (…)` anyway, so
--      that index is a one-liner when it earns its place.
--
--   9. **A document cannot be deleted out from under its versions.** The
--      foreign key is `ON DELETE RESTRICT` and `vorschicht_app` is granted no
--      DELETE on `documents` at all. Both layers say the same thing and
--      neither is redundant: the grant stops the application, the constraint
--      stops the owner — and without it, `DELETE FROM documents` would erase
--      an append-only history one table over, which is the back door every
--      guard in this schema exists to close.
-- =============================================================================

-- --- documents ---------------------------------------------------------------
-- Identity and curation. Mutable (decision 1); every change goes to `audit_log`
-- through `DocumentVault`, which is the only writer.
CREATE TABLE IF NOT EXISTS documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Insertion order, and the deterministic tail of every ranking below.
  --
  -- Equally relevant documents have to come back in *some* order, and if that
  -- order is whatever the planner felt like, then a test asserting that the
  -- department-tagged document comes first can pass without the boost having
  -- done anything. A total order that is knowable from outside is what makes
  -- that test able to fail. Newest first, because among two equally relevant
  -- documents the newer one is the more likely to be the one in force —
  -- statutes and contracts get amended.
  seq              bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  title            text NOT NULL,
  -- §13's two tag kinds. Which departments a document serves best, and free
  -- tags. Department labels are §8's German ones and live in the profile table
  -- (`packages/core/src/profiles`); they are deliberately *not* duplicated into
  -- a constraint here. A43.1 took the opposite bargain for §9's transition map
  -- and named the reason it had to: a CHECK constraint cannot import
  -- TypeScript, so that rule *had* to exist twice. This one does not — a tag
  -- naming a department that no longer exists is a stale tag whose only effect
  -- is a boost that never fires, not a corrupt row.
  department_tags  text[] NOT NULL DEFAULT '{}',
  tags             text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- The *curation* timestamp, not the content one: adding a version does not
  -- touch it. The content's timeline is the version log, which is the thing
  -- §13 asks to be append-only, and having both mean "something changed" would
  -- leave neither answering a question.
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT documents_title_present CHECK (btrim(title) <> ''),
  -- A NULL element matches no department and renders as an empty chip; an
  -- empty string does the same and is harder to see. Both conjuncts are
  -- needed: `'' = ANY (…)` over an array containing NULL evaluates to NULL,
  -- which a CHECK reads as "not violated".
  CONSTRAINT documents_department_tags_clean CHECK (
    array_position(department_tags, NULL::text) IS NULL
    AND NOT ('' = ANY (department_tags))
  ),
  CONSTRAINT documents_tags_clean CHECK (
    array_position(tags, NULL::text) IS NULL
    AND NOT ('' = ANY (tags))
  )
);

COMMENT ON TABLE documents IS
  'The §5 documents entity (§13): vault metadata and tags. Mutable configuration; every write is audit-logged.';

-- --- document_versions -------------------------------------------------------
-- One immutable row per upload (§13: "versions are append-only").
CREATE TABLE IF NOT EXISTS document_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Decision 9.
  document_id     uuid NOT NULL REFERENCES documents (id) ON DELETE RESTRICT,
  version         integer NOT NULL,
  -- What the file was called when it arrived, what it is, how big, and where it
  -- lives under the docs volume. All four are properties of *this* upload and
  -- differ between versions, which is why they sit here rather than on the
  -- document.
  filename        text NOT NULL,
  mime_type       text,
  byte_size       bigint,
  -- sha256 of the stored bytes. Not enforced as unique: the same file uploaded
  -- twice is two versions, and saying so is more useful than refusing it.
  checksum        text,
  storage_path    text NOT NULL,
  -- Decision 5. NULL = not extracted, which is not the same as "extracted and
  -- empty" — a scanned page with no text layer is a real and different answer.
  extracted_text  text,
  -- Decision 2 and 3. `coalesce` because the column is nullable and
  -- `to_tsvector(regconfig, NULL)` yields NULL, which would make the index
  -- carry nothing for exactly the rows a later extraction is meant to fill.
  fts             tsvector GENERATED ALWAYS AS (
                    to_tsvector('german', coalesce(extracted_text, ''))
                  ) STORED,
  uploaded_at     timestamptz NOT NULL DEFAULT now(),
  uploaded_by     text NOT NULL,
  CONSTRAINT document_versions_version_positive CHECK (version >= 1),
  CONSTRAINT document_versions_filename_present CHECK (btrim(filename) <> ''),
  CONSTRAINT document_versions_byte_size_sane CHECK (byte_size IS NULL OR byte_size >= 0),
  -- Decision 6.
  CONSTRAINT document_versions_storage_path_relative CHECK (
    btrim(storage_path) <> ''
    AND storage_path NOT LIKE '/%'
    AND storage_path NOT LIKE '%..%'
  ),
  -- The version numbering, and the concurrency check that comes free with it:
  -- two writers that both computed `max(version) + 1` cannot both succeed.
  CONSTRAINT document_versions_unique UNIQUE (document_id, version)
);

-- Decision 3. The one index this block exists to build.
CREATE INDEX IF NOT EXISTS document_versions_fts_idx
  ON document_versions USING GIN (fts);

-- Read by the "how much of the vault is not searchable yet" count that every
-- search answer carries: a document with no extracted version at all is a
-- document a search cannot find, and reporting zero hits without saying so
-- would be a lie of omission.
--
-- No separate `(document_id, version DESC)` index: the UNIQUE constraint above
-- is a btree on exactly those columns and Postgres scans it backwards for
-- "the latest version".
CREATE INDEX IF NOT EXISTS document_versions_extracted_idx
  ON document_versions (document_id) WHERE extracted_text IS NOT NULL;

CREATE OR REPLACE TRIGGER document_versions_append_only
  BEFORE UPDATE OR DELETE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION vorschicht_deny_mutation();

-- TRUNCATE fires no row-level trigger at all — the hole 0004 exists to close.
CREATE OR REPLACE TRIGGER document_versions_no_truncate
  BEFORE TRUNCATE ON document_versions
  FOR EACH STATEMENT EXECUTE FUNCTION vorschicht_deny_truncate();

COMMENT ON TABLE document_versions IS
  'The §5 document_versions entity (§13): one append-only row per upload, carrying the extracted text and its German full-text index.';

-- --- grants ------------------------------------------------------------------
-- Decision 9: no DELETE on `documents`, deliberately, even though it is the
-- mutable table. §13 describes uploading, versioning and curating; it never
-- describes removing, and the one thing a removal would take with it is an
-- append-only history.
GRANT SELECT, INSERT, UPDATE ON documents TO vorschicht_app;
REVOKE DELETE, TRUNCATE ON documents FROM vorschicht_app;

GRANT SELECT, INSERT ON document_versions TO vorschicht_app;
REVOKE UPDATE, DELETE, TRUNCATE ON document_versions FROM vorschicht_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vorschicht_app;
