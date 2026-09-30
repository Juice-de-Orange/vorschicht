/**
 * Ingest a build report (see migration 0007).
 *
 *   node dist/cli/report-build.js < snapshot.json
 *
 * Runs inside the app container, where `DATABASE_URL` already points at the
 * right database. The build machine ships a snapshot here over SSH rather than
 * reaching into Postgres from outside — the database has no published port
 * (§3), and giving it one so a build script could write progress would be a
 * poor trade.
 *
 * Also writes an `event_log` row, so build progress arrives on the live feed
 * through exactly the same path everything else does.
 */
import { EventLog, loadConfig } from '@vorschicht/core';
import { createSql } from '@vorschicht/db';
import { z } from 'zod';

const snapshotSchema = z.object({
  phase: z.string().min(1),
  step: z.string().nullable().optional(),
  gatesGreen: z.number().int().min(0).default(0),
  gatesDeferred: z.number().int().min(0).default(0),
  gatesOpen: z.number().int().min(0).default(0),
  commits: z.number().int().min(0).default(0),
  headSha: z.string().nullable().optional(),
  headSubject: z.string().nullable().optional(),
  loopRunning: z.boolean().default(false),
  questions: z.array(z.string()).default([]),
});

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const raw = (await readStdin()).trim();
  if (!raw) {
    console.error('report-build: kein Snapshot auf stdin.');
    process.exit(2);
  }

  const parsed = snapshotSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    console.error(
      `report-build: Snapshot ungültig — ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
    process.exit(2);
  }
  const snapshot = parsed.data;

  const config = loadConfig();
  const sql = createSql({ url: config.databaseUrl, max: 1 });

  try {
    const [previous] = await sql<Array<{ phase: string; questions: string[] }>>`
      SELECT phase, questions FROM build_reports ORDER BY id DESC LIMIT 1
    `;

    await sql`
      INSERT INTO build_reports (
        phase, step, gates_green, gates_deferred, gates_open,
        commits, head_sha, head_subject, loop_running, questions, raw
      ) VALUES (
        ${snapshot.phase}, ${snapshot.step ?? null},
        ${snapshot.gatesGreen}, ${snapshot.gatesDeferred}, ${snapshot.gatesOpen},
        ${snapshot.commits}, ${snapshot.headSha ?? null}, ${snapshot.headSubject ?? null},
        ${snapshot.loopRunning}, ${sql.json(snapshot.questions)}, ${sql.json(raw)}
      )
    `;

    // Only a *change* becomes an event. A snapshot every few minutes is useful
    // as state; as a feed it would bury everything else.
    const phaseChanged = previous && previous.phase !== snapshot.phase;
    const questionsChanged =
      previous && JSON.stringify(previous.questions) !== JSON.stringify(snapshot.questions);

    if (!previous || phaseChanged || questionsChanged) {
      await new EventLog(sql).append({
        kind: 'system.started',
        actor: 'bau',
        payload: {
          text: phaseChanged
            ? `Bau: ${snapshot.phase}`
            : questionsChanged
              ? `Bau: ${snapshot.questions.length} offene Frage(n) an the operator`
              : `Bau meldet sich: ${snapshot.phase}`,
          phase: snapshot.phase,
          step: snapshot.step ?? null,
          gates: {
            green: snapshot.gatesGreen,
            deferred: snapshot.gatesDeferred,
            open: snapshot.gatesOpen,
          },
          headSha: snapshot.headSha ?? null,
        },
      });
    }

    console.log(`report-build: ok (${snapshot.phase})`);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
