-- =============================================================================
-- 0021_sources — §14's source registry: the five trust levels, and the history
-- behind every one of them.
--
-- A43's precedent for the sixth time (tasks 0006, worktrees 0008, claims 0009,
-- audits 0013, escalations 0016): the append-only log is the table, the entity
-- is a view over it. Eight decisions here are not transcription of §14.
--
--   1. **Append-only, and this is the opposite call from 0020 one section
--      earlier.** The vault made `documents` *mutable* and said why: a
--      re-tagging is not a new version, and the history a tag change has is the
--      one `audit_log` already keeps (A107.1). Neither half of that argument
--      survives here. §14 gives a source a real lifecycle — a department
--      *proposes* it with a trust assessment, the operator *accepts* or *rejects* it,
--      it is later *promoted* or *demoted*, eventually *retired* — which is
--      0013's sentence word for word: "a mutable `status` column would answer
--      'what is it now' and lose 'how did it get there'".
--
--      And here that loss is not merely inconvenient. §14 makes level ≥ L4 the
--      condition for a legal or compliance output to cite something at all, so
--      *who raised this source to L5, when, and on what grounds* is the only
--      evidence standing behind a Rechtsgutachten. A registry that can only say
--      "L5 today" cannot answer the one question anybody would ask of it a year
--      later. `audit_log` is not a substitute for the same reason it was
--      sufficient for a tag: a tag change has no consequence a reader has to
--      reconstruct, and a level change is the whole basis of a citation.
--
--      Recorded as a contrast rather than left implicit, because 0020 and 0021
--      look like two answers to one question and are two answers to two: the
--      rule is *does this entity have a history somebody will have to
--      reconstruct*, not *is it configuration*.
--
--   2. **The state is derived, never stored.** 0016's sentence applies without
--      change: "an item that has been answered and an item somebody marked as
--      answered are different facts". A proposed source is accepted **because**
--      an acceptance row exists, and a retired one is retired because a
--      retirement row exists — not because a column says so. The rejected
--      alternative was a `status` column maintained by the service, which is
--      the one arrangement in which the registry can disagree with its own log.
--
--   3. **The score is computed in this view and never written.** §14 asks for a
--      "numeric score per source (recency, authority, corroboration) on top of
--      the level", which is by construction a number that changes while nothing
--      happens — the recency term is a function of `now()`. Writing it would
--      mean either an UPDATE (impossible: the guard below binds the owner too)
--      or an event per recomputation, and that is exactly what 0014 refused for
--      the window anchors: "achtzehn gleiche Zeilen pro Stunde begraben die
--      eine, die etwas sagt". An event kind with a de-duplication rule was the
--      considered alternative and it is worse than it looks: the rule would be
--      a threshold ("write only when the value moved by more than ε") that
--      nobody can check, and between two writes the stored number would simply
--      be wrong. A view has no write at all, so there is no rule to get wrong.
--
--      The price is stated rather than discovered: `score` cannot be indexed
--      and a query that orders by it re-computes it per row. The registry is a
--      curated list — tens of rows, not millions — and when that stops being
--      true, the shape that fits is a materialised ranking refreshed on a tick,
--      *beside* this view rather than instead of it.
--
--   4. **The formula is `level + recency`, and it can never cross a level
--      boundary.** The authority term of §14's three *is* the level: the score
--      sits "on top of" it, so it refines the order within a class and must not
--      reorder across classes — otherwise a well-tended L3 would outrank a
--      dusty L4 and §14's citation rule, which is about the level, would read
--      as advisory. The recency term is therefore bounded strictly below 1:
--
--        score = level + RECENCY_WEIGHT / (1 + age_days / 365)
--
--      with `RECENCY_WEIGHT = 0.5` and `age` measured from the most recent
--      curation act. Freshly curated is `level + 0.5`, a year later
--      `level + 0.25`, four years later `level + 0.1`. The other half of the
--      budget is deliberately unspent — see decision 5.
--
--      "Recency" is read as *when a human last affirmed this source's
--      standing*, not as *when the page behind the URL last changed*. The
--      second reading is the better one and it needs a fetcher; Rado's radar
--      (§8, Phase 6) is where that lives, and the shape that fits is a
--      `checked` event carrying the observed last-modified date, at which point
--      this expression takes the newer of the two timestamps. Named here
--      because a migration header cannot be edited once applied.
--
--   5. **Corroboration has no producer, so it contributes nothing and says
--      so.** §14 names three inputs and this schema can compute two. The third
--      counts how often a source was corroborated by others, which needs
--      citations, which is Lena's block (§11's `legal` gate). Half the
--      fractional budget is reserved for it and left at zero rather than
--      approximated: a term wired in with no producer would read as covered and
--      carry no signal, which is §8.2's sixth domain, and A107.7 took the same
--      posture one migration earlier for §13's link entries.
--
--   6. **A source is a URL or a vault document, and the link points this
--      way.** §13 promises reference entries ("Vereinsgesetz on RIS") and
--      A107.7 forwarded them here in as many words: they "belong to §14's
--      source registry, and a versionless document made every join optional".
--      So `documents` gains nothing — a nullable `source_id` on every document
--      would be the one-value column A107.7 refused — and a *source* may point
--      at a document instead of, or as well as, a URL. The direction follows
--      the optionality: not every source has a document (RIS is a URL) and not
--      every document is a source (a contract is evidence, not an authority),
--      but a source has at most one document, so the nullable side is here.
--
--      `url` and `document_id` are real columns rather than payload keys
--      because the database has something to say about both — a foreign key on
--      one, a shape CHECK on the other, an index on each. Everything the
--      database has no opinion about (title, assessment, reason) stays in the
--      payload, which is the rule 0013 and 0016 already follow.
--
--   7. **Every event that changes or removes standing carries its reason.**
--      §14 asks it only implicitly, and for a promotion it is the whole point:
--      a citation at L5 is worth exactly what the sentence that granted L5 is
--      worth. Extending the same CHECK to a rejection and a retirement costs a
--      line and buys the thing an append-only log exists for — a later reader
--      who can tell *why*. An acceptance takes an optional note instead: its
--      reason is the proposal's assessment, which is already stored.
--
--   8. **The lifecycle is a log, not a straight line, and no constraint
--      pretends otherwise.** A source rejected in 2026 may be proposed again on
--      better evidence and accepted; a retired one may come back. The only
--      ordering rule is that the proposal is the first event and every other
--      event needs one to exist — which the two CHECKs below make structural
--      rather than conventional: an `accepted` row for an unknown source
--      computes `seq = 1` and is refused, so the registry cannot accept
--      something nobody proposed.
--
--      Deliberately **not** constrained: two sources may carry the same URL. A
--      re-proposal of a rejected source is legitimate and a partial unique
--      index could not tell it from a duplicate, because "is it accepted" is
--      derived (decision 2) and an index cannot read a view. Two *accepted*
--      sources for one URL is a real curation problem and the place to catch it
--      is the proposal producer (§15's card, another block), which is why
--      `url` carries an index and `SourceRegistry.list` takes a URL filter.
-- =============================================================================

-- --- source_events -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS source_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id   uuid NOT NULL,
  seq         integer NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- `level_changed` is deliberately not a state: §14's promotion and demotion
  -- move the trust level of a source that stays in the registry throughout, and
  -- folding it into the state would make "accepted" unreadable after the first
  -- promotion. The view treats the two axes separately for the same reason.
  kind        text NOT NULL CHECK (kind IN (
    'proposed', 'accepted', 'rejected', 'level_changed', 'retired'
  )),
  -- The proposing department's role id, `max` or `dashboard:<credentialId>` for
  -- a curation act. §14 leaves inclusion to the operator; the log records who actually
  -- wrote each line.
  actor       text NOT NULL,
  -- Decision 6. Only a proposal carries the reference, because the reference is
  -- what the source *is* — a later event that could change it would silently
  -- turn one source into another while keeping its history.
  url         text,
  document_id uuid REFERENCES documents (id) ON DELETE RESTRICT,
  -- On a proposal this is the department's assessment; on an acceptance or a
  -- level change it is what the registry grants. Two different facts, projected
  -- into two different columns by the view.
  level       integer,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source_id, seq),

  -- Decision 8. Together with `COALESCE(MAX(seq), 0) + 1` computed inside the
  -- insert, this refuses an event for a source that does not exist: with no
  -- rows the next seq is 1, and 1 is reserved for the proposal.
  CONSTRAINT source_events_proposal_is_first CHECK ((kind = 'proposed') = (seq = 1)),

  CONSTRAINT source_events_level_where_meant CHECK (
    (kind IN ('proposed', 'accepted', 'level_changed')) = (level IS NOT NULL)
  ),
  -- §14 has exactly five levels. A sixth would rank above L5 and be citable by
  -- every rule written against `>= 4`.
  CONSTRAINT source_events_level_range CHECK (level IS NULL OR level BETWEEN 1 AND 5),

  -- Decision 6: the reference belongs to the proposal and nowhere else, and a
  -- proposal must carry at least one half of it.
  CONSTRAINT source_events_reference_on_proposal CHECK (
    CASE WHEN kind = 'proposed'
      THEN url IS NOT NULL OR document_id IS NOT NULL
      ELSE url IS NULL AND document_id IS NULL
    END
  ),
  -- A citation is a link somebody follows, so the one thing that must never be
  -- stored is a string that is not one. Refused at the door for A87.7's reason:
  -- after this row exists, every reader has to remember.
  CONSTRAINT source_events_url_shape CHECK (
    url IS NULL OR url ~ '^https?://[^[:space:]]+$'
  ),

  CONSTRAINT source_events_title_on_proposal CHECK (
    kind <> 'proposed' OR btrim(COALESCE(payload ->> 'title', '')) <> ''
  ),
  -- Decision 7.
  CONSTRAINT source_events_reason_where_required CHECK (
    kind NOT IN ('rejected', 'level_changed', 'retired')
    OR btrim(COALESCE(payload ->> 'reason', '')) <> ''
  )
);

CREATE INDEX IF NOT EXISTS source_events_source_idx ON source_events (source_id, seq);

-- Decision 8: the duplicate lookup a proposal producer performs before asking
-- the operator the same question twice.
CREATE INDEX IF NOT EXISTS source_events_url_idx ON source_events (url) WHERE url IS NOT NULL;

-- The foreign key above gives no index of its own, and `documents` is RESTRICT:
-- without this, refusing a delete means a sequential scan of the whole log.
CREATE INDEX IF NOT EXISTS source_events_document_idx
  ON source_events (document_id) WHERE document_id IS NOT NULL;

CREATE OR REPLACE TRIGGER source_events_append_only
  BEFORE UPDATE OR DELETE ON source_events
  FOR EACH ROW EXECUTE FUNCTION vorschicht_deny_mutation();

-- TRUNCATE fires no row-level trigger at all — the hole 0004 exists to close.
CREATE OR REPLACE TRIGGER source_events_no_truncate
  BEFORE TRUNCATE ON source_events
  FOR EACH STATEMENT EXECUTE FUNCTION vorschicht_deny_truncate();

COMMENT ON TABLE source_events IS
  'Append-only log behind the §5 sources entity: one proposal per source (§14), then every curation act on it.';

-- --- sources (derived) -------------------------------------------------------
-- §5's `sources`: "URL/reference, trust level 1–5, score, curated-by, proposal
-- state". Every one of those is projected from the log rather than stored.
--
-- Two levels, deliberately, because they are two facts. `proposed_level` is
-- what a department assessed; `level` is what the registry granted, and it is
-- NULL until somebody granted it. A single column would make a pending
-- proposal indistinguishable from an accepted source at the same level, which
-- is precisely the distinction §14's citation rule turns on.
CREATE OR REPLACE VIEW sources AS
WITH proposal AS (
  SELECT source_id, occurred_at, actor, url, document_id, level, payload
  FROM source_events WHERE kind = 'proposed'
),
-- Decision 2. `level_changed` is absent on purpose: a promotion is not a change
-- of state, and including it here would make every promoted source read as
-- being in a state called "level_changed".
standing AS (
  SELECT DISTINCT ON (source_id) source_id, kind, occurred_at, payload
  FROM source_events
  WHERE kind IN ('proposed', 'accepted', 'rejected', 'retired')
  ORDER BY source_id, seq DESC
),
-- The level the registry currently grants, and the sentence that granted it.
granted AS (
  SELECT DISTINCT ON (source_id) source_id, level, occurred_at, payload
  FROM source_events
  WHERE kind IN ('accepted', 'level_changed')
  ORDER BY source_id, seq DESC
),
-- §5's "curated-by": who last decided anything about this source, and when.
-- Retirement counts — it is a curation act — while a proposal does not, because
-- proposing is asking rather than deciding.
curation AS (
  SELECT DISTINCT ON (source_id) source_id, occurred_at, actor
  FROM source_events
  WHERE kind IN ('accepted', 'level_changed', 'retired')
  ORDER BY source_id, seq DESC
)
SELECT
  p.source_id                    AS id,
  p.url,
  p.document_id,
  p.payload ->> 'title'          AS title,
  -- §14: "an inbox item with the agent's trust assessment". Kept on the source
  -- rather than only on the card, because the card is answered and closed while
  -- the assessment is the reasoning behind a level that outlives it.
  p.payload ->> 'assessment'     AS assessment,
  p.level                        AS proposed_level,
  g.level                        AS level,
  s.kind                         AS state,
  s.payload ->> 'reason'         AS state_reason,
  g.payload ->> 'reason'         AS level_reason,
  p.occurred_at                  AS proposed_at,
  p.actor                        AS proposed_by,
  c.occurred_at                  AS curated_at,
  c.actor                        AS curated_by,
  -- Decisions 3, 4 and 5.
  --
  -- NULL for anything that is not accepted: §14's score is a ranking number,
  -- and a proposal nobody has decided on, a rejected source and a retired one
  -- are not in the ranking at all. A zero would sort them last, which is a
  -- different and wrong statement — they have no place in the order rather than
  -- the worst one.
  --
  -- 31536000 = 365 days in seconds. 0.5 is RECENCY_WEIGHT; the remaining 0.5 of
  -- the sub-level budget belongs to corroboration and is unspent (decision 5),
  -- which is why the whole fractional part stays strictly below 1 and the score
  -- can never reach the next level's floor.
  CASE WHEN s.kind = 'accepted' AND g.level IS NOT NULL THEN
    round(
      g.level + 0.5 / (1 + EXTRACT(EPOCH FROM (now() - c.occurred_at)) / 31536000.0),
      4
    )
  END                            AS score
FROM proposal p
JOIN standing s USING (source_id)
LEFT JOIN granted g USING (source_id)
LEFT JOIN curation c USING (source_id);

COMMENT ON VIEW sources IS
  'The §5 sources entity (§14): trust level, proposal state, curated-by and the recency-refined score, all derived from source_events.';

GRANT SELECT, INSERT ON source_events TO vorschicht_app;
REVOKE UPDATE, DELETE, TRUNCATE ON source_events FROM vorschicht_app;
GRANT SELECT ON sources TO vorschicht_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vorschicht_app;
