/**
 * §13's document vault against a real Postgres (migration 0020).
 *
 * Everything load-bearing here *is* the database. The append-only guarantee is
 * a trigger, the tag hygiene is a CHECK, the version numbering is a unique
 * constraint, and the ranking is an `ORDER BY` over a German full-text index —
 * a stubbed store would let every one of those assertions pass against a lie.
 *
 * Three things this suite is deliberately built to be able to fail.
 *
 *   1. **The ranking case has a checked premise.** §22's Phase 6 gate asks that
 *      an agent retrieves a document "ranked by department tag", so what has to
 *      be proven is an *order*, and an order between two documents is only
 *      about the boost if the two are otherwise equal. The case therefore
 *      asserts that both hits come back with the same `rank` before it asserts
 *      which one is first: if Postgres ever starts ranking them apart, this
 *      goes red where it stands rather than passing for a reason nobody
 *      checked.
 *
 *   2. **The untagged document is the one that wins every tie-break.** It is
 *      created *second*, and the final tie-break is `seq DESC`, so with the
 *      boost removed — or with both documents tagged — the expected order
 *      inverts. That is the whole point: a ranking test whose expectation
 *      happens to agree with the insertion order proves nothing about ranking.
 *      Both mutations were run against a real Postgres. `DEPARTMENT_BOOST = 1`
 *      reddens it with *"expected 1 to be less than 0"*; tagging both
 *      documents first trips the `departmentMatch` assertion, so it was re-run
 *      with that assertion removed to isolate the ordering, and reddens it
 *      with the same message. A third, `DEPARTMENT_BOOST = 1.6`, reddens the
 *      neighbouring "boost is not a tier" case — which is what makes the
 *      measured upper bound in `documents.ts` a checked claim rather than a
 *      remark.
 *
 *   3. **TRUNCATE is asserted alongside UPDATE and DELETE, because nothing
 *      else would.** `gate:migrations` only ever looks for the `_append_only`
 *      trigger, and a statement-level guard is invisible to a row-level one
 *      (0004's reason). Measured rather than assumed: with
 *      `document_versions_no_truncate` deleted from the migration,
 *      `pnpm gate:migrations` still reports *"✓ 20 Migration(en), 14
 *      append-only-Tabelle(n) geschützt"* and only these two cases go red.
 */
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEPARTMENT_BOOST, DocumentVault, type NewVersionSpec } from './documents.js';

const url = process.env.TEST_DATABASE_URL;

/** §8's German label for the department that owns Statuten and AVVs. */
const RECHT = 'Recht';

function upload(over: Partial<NewVersionSpec> = {}): NewVersionSpec {
  return {
    filename: 'statuten.pdf',
    storagePath: 'vault/statuten.pdf',
    mimeType: 'application/pdf',
    byteSize: 1024,
    checksum: 'a'.repeat(64),
    extractedText: null,
    ...over,
  };
}

describe.skipIf(!url)('Dokumententresor (§13)', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let vault: DocumentVault;

  beforeAll(async () => {
    database = await createTestDatabase('vault');
    sql = createSql({ url: database.url, max: 3 });
    vault = new DocumentVault(sql);
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
  });

  describe('die Versionen sind append-only, die Metadaten nicht', () => {
    it('nimmt eine Version an und weigert sich, sie später zu ändern', async () => {
      const { version } = await vault.create({
        title: 'Vereinsstatuten',
        version: upload({ extractedText: 'Der Verein führt den Namen Testverein.' }),
      });
      expect(version.version).toBe(1);

      await expect(
        sql`UPDATE document_versions SET filename = 'gefälscht' WHERE id = ${version.id}`,
      ).rejects.toThrow(/append-only/i);
      await expect(sql`DELETE FROM document_versions WHERE id = ${version.id}`).rejects.toThrow(
        /append-only/i,
      );
    });

    it('weigert sich auch gegen TRUNCATE — was kein Zeilen-Trigger je sieht', async () => {
      await expect(sql.unsafe('TRUNCATE document_versions')).rejects.toThrow(/append-only/i);
    });

    it('trägt beide Wächter unter ihren erwarteten Namen', async () => {
      const rows = await sql<{ tgname: string }[]>`
        SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'document_versions'::regclass AND NOT tgisinternal
      `;
      const names = rows.map((r) => r.tgname);
      expect(names).toContain('document_versions_append_only');
      expect(names).toContain('document_versions_no_truncate');
    });

    it('gibt der Laufzeitrolle auf den Versionen kein UPDATE und kein DELETE', async () => {
      const granted = await grantsFor(sql, 'document_versions');
      expect(granted).toContain('SELECT');
      expect(granted).toContain('INSERT');
      expect(granted).not.toContain('UPDATE');
      expect(granted).not.toContain('DELETE');
    });

    it('lässt die Metadaten ändern, aber nicht löschen (§13, Entscheidung 9)', async () => {
      const granted = await grantsFor(sql, 'documents');
      expect(granted).toContain('SELECT');
      expect(granted).toContain('INSERT');
      // Die eine Tabelle in diesem Block, die veränderlich sein *soll*.
      expect(granted).toContain('UPDATE');
      expect(granted).not.toContain('DELETE');
    });

    /**
     * Zwei Schichten, und die Zusicherung muss sie unterscheiden können.
     *
     * Die erste Fassung prüfte `/foreign key|document_versions/i` und blieb
     * grün, als der Fremdschlüssel versuchsweise auf `ON DELETE CASCADE`
     * stand — weil dann der **Append-only-Trigger** der Kindzeile feuert und
     * seine Meldung den Tabellennamen enthält. Der Fall hätte also eine
     * Schicht bezeugt, die er gar nicht meint, und der Wechsel auf CASCADE
     * wäre unbemerkt geblieben. Jetzt wird die Meldung des Fremdschlüssels
     * verlangt (mit RESTRICT feuert er *vor* dem Trigger) — und zusätzlich
     * das, was substanziell zählt: die Historie steht danach noch da.
     */
    it('lässt kein Dokument löschen, an dem eine Versionshistorie hängt', async () => {
      const { document } = await vault.create({
        title: 'Auftragsverarbeitungsvertrag',
        version: upload({ storagePath: 'vault/avv.pdf' }),
      });
      // Als Eigentümer, also an den GRANTs vorbei: der Fremdschlüssel ist die
      // Schicht, die auch den bindet.
      await expect(sql`DELETE FROM documents WHERE id = ${document.id}`).rejects.toThrow(
        /violates foreign key constraint/i,
      );
      const [rest] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM document_versions WHERE document_id = ${document.id}
      `;
      expect(rest?.count).toBe(1);
    });
  });

  describe('die Randbedingungen, die das Schema selbst durchsetzt', () => {
    it('weist einen absoluten Ablagepfad und einen mit ".." zurück', async () => {
      await expect(
        vault.create({
          title: 'Absolut',
          version: upload({ storagePath: '/srv/vorschicht/x.pdf' }),
        }),
      ).rejects.toThrow(/storage_path_relative/);
      await expect(
        vault.create({ title: 'Ausbruch', version: upload({ storagePath: 'vault/../../etc/x' }) }),
      ).rejects.toThrow(/storage_path_relative/);
    });

    it('weist ein NULL-Element in den Abteilungs-Tags zurück', async () => {
      // Am Dienst vorbei: `cleanTags` fängt das ab, und genau deshalb muss die
      // zweite Schicht getrennt geprüft werden.
      await expect(
        sql`
          INSERT INTO documents (title, department_tags)
          VALUES ('Kaputt', ARRAY['Recht', NULL]::text[])
        `,
      ).rejects.toThrow(/department_tags_clean/);
    });

    it('weist einen leeren Tag zurück', async () => {
      await expect(
        sql`INSERT INTO documents (title, tags) VALUES ('Kaputt', ARRAY['']::text[])`,
      ).rejects.toThrow(/tags_clean/);
    });

    it('weist einen leeren Titel zurück', async () => {
      await expect(vault.create({ title: '   ', version: upload() })).rejects.toThrow(
        /title_present/,
      );
    });
  });

  describe('anlegen, versionieren, umtaggen', () => {
    it('legt Metadaten und erste Version in einem Zug an und schreibt eine Prüfspur', async () => {
      const { document, version } = await vault.create(
        {
          title: 'Datenschutzerklärung',
          departmentTags: [RECHT, '  ', RECHT, ' Sicherheit '],
          tags: ['dsgvo', 'dsgvo'],
          version: upload({ storagePath: 'vault/dse-1.pdf', extractedText: 'Wir verarbeiten.' }),
        },
        'dashboard:operator',
      );

      // Getrimmt, entdoppelt, Reihenfolge erhalten.
      expect(document.departmentTags).toEqual([RECHT, 'Sicherheit']);
      expect(document.tags).toEqual(['dsgvo']);
      expect(version.documentId).toBe(document.id);
      expect(version.version).toBe(1);
      expect(version.uploadedBy).toBe('dashboard:operator');

      const trail = await auditFor(sql, document.id);
      expect(trail.map((row) => row.action)).toEqual(['document.created']);
      expect(trail[0]?.actor).toBe('dashboard:operator');
    });

    it('hängt Versionen an und lässt die früheren unangetastet', async () => {
      const { document, version: first } = await vault.create({
        title: 'Vereinsstatuten 2020',
        version: upload({ storagePath: 'vault/statuten-1.pdf', extractedText: 'Fassung 2020.' }),
      });
      const second = await vault.addVersion(
        document.id,
        upload({ storagePath: 'vault/statuten-2.pdf', extractedText: 'Fassung 2024.' }),
        'doris',
      );
      const third = await vault.addVersion(
        document.id,
        upload({ storagePath: 'vault/statuten-3.pdf' }),
      );

      expect([first.version, second.version, third.version]).toEqual([1, 2, 3]);

      const detail = await vault.get(document.id);
      expect(detail?.versions.map((v) => v.version)).toEqual([3, 2, 1]);
      expect(detail?.versions.at(-1)?.extractedText).toBe('Fassung 2020.');
      // §13s "noch nicht gelesen" ist ein eigener Zustand, kein leerer String.
      expect(detail?.versions[0]?.extractedText).toBeNull();

      const trail = await auditFor(sql, document.id);
      expect(trail.map((row) => row.action)).toEqual([
        'document.created',
        'document.version_added',
        'document.version_added',
      ]);
    });

    /**
     * `audit_log` ist append-only und wird nach §18 nie gelöscht — was einmal
     * darin steht, bekommt niemand wieder heraus. Der Inhalt einer Statute
     * gehört deshalb nicht hinein: er ist in `document_versions` ohnehin schon
     * unveränderlich aufgezeichnet, und §13s "with audit log" fragt, *wer was
     * mit welcher Version* getan hat. A53.6s Deckel auf Assistenten-Prosa ist
     * dieselbe Überlegung eine Etage höher.
     */
    it('schreibt den Volltext nicht in die Prüfspur, wohl aber seine Länge', async () => {
      const secret = 'Vertraulicher Paragraph über die Auflösung des Vereins.';
      const { document } = await vault.create({
        title: 'Vertraulich',
        version: upload({ storagePath: 'vault/vertraulich.pdf', extractedText: secret }),
      });
      await vault.addVersion(
        document.id,
        upload({ storagePath: 'vault/vertraulich-2.pdf', extractedText: secret }),
      );

      const trail = await auditFor(sql, document.id);
      expect(JSON.stringify(trail)).not.toContain('Auflösung des Vereins');
      for (const row of trail) {
        const version = (row.after as { version?: Record<string, unknown> } | null)?.version;
        expect(version).toBeDefined();
        expect(version).not.toHaveProperty('extractedText');
        // Die eine Aussage, die die Kennungen allein nicht treffen können.
        expect(version?.extractedTextChars).toBe(secret.length);
        expect(version?.checksum).toBe('a'.repeat(64));
      }
    });

    it('verweigert eine Version für ein Dokument, das es nicht gibt — und schreibt nichts', async () => {
      const ghost = '00000000-0000-0000-0000-000000000042';
      await expect(vault.addVersion(ghost, upload())).rejects.toThrow(/existiert nicht/);
      expect(await auditFor(sql, ghost)).toHaveLength(0);
      const [row] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM document_versions WHERE document_id = ${ghost}
      `;
      expect(row?.count).toBe(0);
    });

    it('taggt um, protokolliert Vorher und Nachher und schweigt bei einer Nulländerung', async () => {
      const { document } = await vault.create({
        title: 'AVV Hosting',
        departmentTags: ['Ops'],
        version: upload({ storagePath: 'vault/avv-hosting.pdf' }),
      });

      const after = await vault.setTags(
        document.id,
        { departmentTags: [RECHT, 'Ops'], tags: ['vertrag'] },
        'dashboard:operator',
      );
      expect(after.departmentTags).toEqual([RECHT, 'Ops']);
      expect(after.tags).toEqual(['vertrag']);
      expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(document.updatedAt.getTime());

      const trail = await auditFor(sql, document.id);
      const change = trail.find((row) => row.action === 'document.tags_changed');
      expect(change?.before).toMatchObject({ departmentTags: ['Ops'], tags: [] });
      expect(change?.after).toMatchObject({ departmentTags: [RECHT, 'Ops'], tags: ['vertrag'] });

      // Dieselben Tags noch einmal: keine Änderung, also auch keine Zeile.
      await vault.setTags(document.id, { departmentTags: [RECHT, 'Ops'], tags: ['vertrag'] });
      expect(
        (await auditFor(sql, document.id)).filter((r) => r.action === 'document.tags_changed'),
      ).toHaveLength(1);
    });

    it('lässt eine Teilangabe die andere Tag-Liste in Ruhe', async () => {
      const { document } = await vault.create({
        title: 'Hausordnung',
        departmentTags: ['Ops'],
        tags: ['intern'],
        version: upload({ storagePath: 'vault/hausordnung.pdf' }),
      });
      const after = await vault.setTags(document.id, { tags: ['intern', 'aushang'] });
      expect(after.departmentTags).toEqual(['Ops']);
      expect(after.tags).toEqual(['intern', 'aushang']);
    });

    it('antwortet auf ein unbekanntes Dokument mit null statt mit einer leeren Hülle', async () => {
      expect(await vault.get('00000000-0000-0000-0000-000000000043')).toBeNull();
    });
  });

  describe('Suche und Abteilungs-Boost (§13)', () => {
    /**
     * Der tragende Fall, und er ist eine Aussage über die **Reihenfolge**.
     *
     * Beide Dokumente enthalten denselben Begriff gleich oft, also ist der
     * einzige Unterschied der Abteilungs-Tag. Das ungetaggte wird **zuletzt**
     * angelegt und gewinnt damit jeden Gleichstand (`seq DESC`) — ohne Boost
     * steht es vorn und der Fall wird rot.
     */
    it('liefert beide Treffer, das für die Abteilung getaggte zuerst', async () => {
      const term = 'Kündigungsfrist';
      const tagged = await vault.create({
        title: 'Mustervertrag (Recht)',
        departmentTags: [RECHT],
        version: upload({
          storagePath: 'vault/rank-tagged.pdf',
          extractedText: `Die ${term} beträgt drei Monate. Eine ${term} gilt auch für den Vorstand.`,
        }),
      });
      const untagged = await vault.create({
        title: 'Handbuch (ohne Abteilung)',
        version: upload({
          storagePath: 'vault/rank-untagged.pdf',
          extractedText: `Im Handbuch steht die ${term}. Jede ${term} wird dokumentiert.`,
        }),
      });

      const { hits } = await vault.search({ query: term, department: RECHT });
      const ids = hits.map((hit) => hit.document.id);
      expect(ids).toContain(tagged.document.id);
      expect(ids).toContain(untagged.document.id);

      const first = hits.find((hit) => hit.document.id === tagged.document.id);
      const second = hits.find((hit) => hit.document.id === untagged.document.id);
      // Die Prämisse, geprüft statt angenommen: gleicher Begriff, gleich oft,
      // also identische Textrelevanz. Nur so ist die Reihenfolge unten eine
      // Aussage über den Boost und nicht über den Text.
      expect(first?.rank).toBe(second?.rank);
      expect(first?.departmentMatch).toBe(true);
      expect(second?.departmentMatch).toBe(false);
      expect(first?.score).toBeCloseTo((second?.score ?? 0) * DEPARTMENT_BOOST, 5);

      expect(ids.indexOf(tagged.document.id)).toBeLessThan(ids.indexOf(untagged.document.id));
    });

    /**
     * Die Gegenrichtung, und zugleich die Obergrenze für `DEPARTMENT_BOOST`.
     *
     * §13 sagt „boosts", §14 sagt „weighted reference works, **not**
     * restrictions". `ts_rank` sättigt aber: ein Vorkommen rankt 0,0608, sechs
     * ranken 0,0907 — ein Verhältnis von 1,49. Ein Faktor darüber macht den
     * Abteilungs-Tag für jede Einwortsuche entscheidend, egal was im Text
     * steht, und aus dem Boost wird die Stufe, die beide Abschnitte ablehnen.
     * Dieser Fall ist deshalb kein Beiwerk, sondern die einzige Zusicherung,
     * die den *Wert* der Konstante prüft statt nur ihre Anwendung.
     */
    it('ist ein Boost und keine Rangfolge: klar relevanter schlägt getaggt', async () => {
      const term = 'Beitragsordnung';
      const tagged = await vault.create({
        title: 'Randnotiz (Recht)',
        departmentTags: [RECHT],
        version: upload({
          storagePath: 'vault/boost-weak.pdf',
          extractedText: `Siehe ${term}.`,
        }),
      });
      const relevant = await vault.create({
        title: 'Die Beitragsordnung selbst',
        version: upload({
          storagePath: 'vault/boost-strong.pdf',
          extractedText: Array.from({ length: 6 }, (_, i) => `${term} Absatz ${i + 1}.`).join(' '),
        }),
      });

      const { hits } = await vault.search({ query: term, department: RECHT });
      const ids = hits.map((hit) => hit.document.id);
      expect(ids.indexOf(relevant.document.id)).toBeLessThan(ids.indexOf(tagged.document.id));
      // …und der Boost hat trotzdem gefeuert; er war nur nicht genug.
      const schwach = hits.find((hit) => hit.document.id === tagged.document.id);
      expect(schwach?.departmentMatch).toBe(true);
      expect(schwach?.score).toBeGreaterThan(schwach?.rank ?? 0);
    });

    it('sucht ohne Abteilung genauso breit, nur ohne Boost', async () => {
      const { hits } = await vault.search({ query: 'Kündigungsfrist' });
      expect(hits.length).toBeGreaterThanOrEqual(2);
      expect(hits.every((hit) => hit.departmentMatch === false)).toBe(true);
      expect(hits.every((hit) => hit.score === hit.rank)).toBe(true);
    });

    /**
     * Die Hälfte, die `'german'` gegenüber `'simple'` rechtfertigt — und die
     * Hälfte, die es nicht tut, weil der Migrationskopf beide behauptet und
     * nach dem ersten Anwenden unveränderlich ist.
     *
     * Das Dokument trägt jeweils nur **eine** Form: ein Text, der beide
     * enthält, belegt nur, dass ein Wort sich selbst findet.
     *
     * Die zweite Zusicherung ist bewusst eine über eine Fremdkomponente, und
     * das ist ihr Zweck: schlägt sie eines Tages um, hat der Snowball-Stemmer
     * dazugelernt und die als dauerhaft notierte Grenze in 0020 stimmt nicht
     * mehr — was jemand erfahren soll, statt es als „gilt weiterhin" zu lesen.
     */
    it('findet die gebeugte Form über den Stamm, aber das Partizip nicht', async () => {
      const flektiert = await vault.create({
        title: 'Protokoll der Generalversammlung',
        version: upload({
          storagePath: 'vault/protokoll.pdf',
          extractedText: 'Die Kündigung der Verträge wurde vom Vorstand ausgesprochen.',
        }),
      });
      const partizip = await vault.create({
        title: 'Aktenvermerk',
        version: upload({
          storagePath: 'vault/vermerk.pdf',
          extractedText: 'Der Vertrag wurde fristgerecht gekündigt.',
        }),
      });

      // Plural findet Singular, und die Zeichenkette „Kündigungen" steht in
      // keinem der beiden Texte — es ist also wirklich der Stamm.
      const treffer = (await vault.search({ query: 'Kündigungen' })).hits.map((h) => h.document.id);
      expect(treffer).toContain(flektiert.document.id);
      expect(treffer).not.toContain(partizip.document.id);
    });

    it('nennt die Version, die getroffen hat, und zählt ein Dokument nur einmal', async () => {
      const term = 'Revisionsbericht';
      const { document } = await vault.create({
        title: 'Revision',
        version: upload({
          storagePath: 'vault/revision-1.pdf',
          extractedText: `Ein ${term}.`,
        }),
      });
      await vault.addVersion(
        document.id,
        upload({
          storagePath: 'vault/revision-2.pdf',
          extractedText: `${term}. ${term}. ${term}.`,
        }),
      );

      const { hits } = await vault.search({ query: term });
      const mine = hits.filter((hit) => hit.document.id === document.id);
      expect(mine).toHaveLength(1);
      // Die zweite Fassung enthält den Begriff öfter, also ist sie die bessere.
      expect(mine[0]?.version).toBe(2);
    });

    it('sagt, wie viel des Tresors noch gar nicht durchsuchbar ist', async () => {
      const before = await vault.search({ query: 'Zustellbevollmächtigter' });
      const { document } = await vault.create({
        title: 'Eingescanntes Blatt',
        version: upload({ storagePath: 'vault/scan.pdf', extractedText: null }),
      });

      const after = await vault.search({ query: 'Zustellbevollmächtigter' });
      expect(after.pendingDocuments).toBe(before.pendingDocuments + 1);
      // Kein Treffer — aber die Antwort sagt, dass sie ihn auch nicht hätte
      // finden können. Das ist der Unterschied, den §13 hier braucht.
      expect(after.hits.map((hit) => hit.document.id)).not.toContain(document.id);

      // Und ein gelesenes Dokument ohne Treffer zählt *nicht* als ausstehend.
      await vault.addVersion(
        document.id,
        upload({ storagePath: 'vault/scan-ocr.pdf', extractedText: 'Nur belangloser Text.' }),
      );
      const later = await vault.search({ query: 'Zustellbevollmächtigter' });
      expect(later.pendingDocuments).toBe(before.pendingDocuments);
    });

    it('wirft nicht an einer Eingabe, die eine Suchmaske wirklich bekommt', async () => {
      for (const query of ['-', '"', 'a & | b', '', '   ']) {
        await expect(vault.search({ query })).resolves.toMatchObject({ hits: [] });
      }
    });

    it('achtet das Limit', async () => {
      const { hits } = await vault.search({ query: 'Kündigungsfrist', limit: 1 });
      expect(hits).toHaveLength(1);
    });
  });
});

async function grantsFor(sql: postgres.Sql, table: string): Promise<string[]> {
  const rows = await sql<{ privilege_type: string }[]>`
    SELECT privilege_type FROM information_schema.role_table_grants
    WHERE grantee = 'vorschicht_app' AND table_name = ${table}
  `;
  return rows.map((row) => row.privilege_type);
}

interface AuditRow {
  actor: string;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

async function auditFor(sql: postgres.Sql, subject: string): Promise<AuditRow[]> {
  return sql<AuditRow[]>`
    SELECT actor, action, before, after FROM audit_log
    WHERE subject = ${subject} ORDER BY id
  `;
}
