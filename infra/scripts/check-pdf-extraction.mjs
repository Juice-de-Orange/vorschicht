#!/usr/bin/env node
/**
 * §13's PDF extraction, inside the built `app` image and under the hardening
 * that image actually runs with.
 *
 *   infra/scripts/check-pdf-extraction.mjs [--image vorschicht-app:latest] [--build]
 *
 * Everything about `PdfTextExtractor` that can be decided without poppler is
 * decided in `packages/core/src/vault/extraction.test.ts`, and it runs
 * everywhere. What no suite on a developer's machine can answer is this:
 *
 *   1. **Does the parser exist where it will run, at the version claimed?**
 *      `Dockerfile.app` asserts it at build time; this asserts it against the
 *      built artefact, and compares it with the `ARG` parsed out of that same
 *      Dockerfile — so the check and the image cannot drift apart silently.
 *
 *   2. **Does it work under `read_only`, `cap_drop: ALL` and no `HOME`?** This
 *      is the question the whole choice of image rests on. Every other proof —
 *      the host probe, the unit suite, the integration test, even a plain
 *      `docker run` — has a writable filesystem and an inherited environment,
 *      so a poppler or fontconfig that wanted a cache directory would be green
 *      in all of them and red only in production. The flags below are taken
 *      from the `app` service in `infra/docker-compose.yml`, plus the minimal
 *      environment `pdftotextEnv` hands the child.
 *
 *   3. **Does the whole extractor answer, or merely the binary?** The probe
 *      runs the image's own compiled `MediaTypeExtractor`, not `pdftotext`
 *      directly, and asserts the two answers that must never merge: a scan with
 *      no text layer is `''` (a parser ran and found nothing) and a damaged
 *      file is `null` (nothing read it).
 *
 * Exit: 0 all green · 1 an assertion does not hold · 2 nothing was checked —
 * no docker, no image, an unreadable Dockerfile (A25/A50: "not checked" is not
 * a finding, and must not be reported as one).
 */
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dockerfile = join(repoRoot, 'infra', 'docker', 'Dockerfile.app');

function arg(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (argv[index + 1] ?? fallback);
}

const image = arg('image', 'vorschicht-app:latest');
const shouldBuild = argv.includes('--build');

async function run(file, args, options = {}) {
  try {
    const { stdout, stderr } = await execFile(file, args, {
      maxBuffer: 32 * 1024 * 1024,
      ...options,
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error.message) };
  }
}

/** Nothing was checked — never a finding (A25). */
function unchecked(message) {
  console.error(`check-pdf-extraction — nicht geprüft: ${message}`);
  exit(2);
}

// --- preconditions ---------------------------------------------------------------

if (!(await run('docker', ['info'], { timeout: 20_000 })).ok) {
  unchecked('Docker ist nicht erreichbar.');
}

/** The version the image promises, read from the Dockerfile rather than repeated. */
let expectedVersion;
try {
  const text = await readFile(dockerfile, 'utf8');
  expectedVersion = text.match(/^ARG POPPLER_VERSION=([0-9][0-9.]*)$/m)?.[1];
} catch (error) {
  unchecked(`${dockerfile} ist nicht lesbar: ${error.message}`);
}
if (!expectedVersion) unchecked(`${dockerfile} nennt kein ARG POPPLER_VERSION=<version>.`);

if (shouldBuild) {
  console.log(`· baue ${image} …`);
  const built = await run('docker', ['build', '-f', dockerfile, '-t', image, repoRoot], {
    timeout: 20 * 60_000,
  });
  if (!built.ok) unchecked(`Der Bau von ${image} ist gescheitert:\n${built.stderr}`);
}

if (!(await run('docker', ['image', 'inspect', image])).ok) {
  unchecked(
    `Das Image „${image}" gibt es nicht. Entweder --build anhängen oder vorher bauen:\n` +
      `  docker build -f infra/docker/Dockerfile.app -t ${image} .`,
  );
}

// --- the probe that runs inside ----------------------------------------------------

/**
 * Written to a temp file and mounted read-only.
 *
 * It imports the image's **own** compiled core, so what is exercised is the
 * artefact that ships rather than this working tree.
 */
const probe = `
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MediaTypeExtractor,
  buildTestPdf,
  buildDamagedPdf,
} from '/app/node_modules/@vorschicht/core/dist/index.js';

const dir = await mkdtemp(join(tmpdir(), 'pdf-'));
const extractor = new MediaTypeExtractor();

async function extract(name, bytes) {
  const path = join(dir, name + '.pdf');
  await writeFile(path, bytes);
  return extractor.extract({ absolutePath: path, mimeType: 'application/pdf', filename: name + '.pdf' });
}

console.log(JSON.stringify({
  mitText: await extract('mit', buildTestPdf(['Die Kuendigung erfolgt schriftlich'])),
  umlaut: await extract('umlaut', buildTestPdf(['Kündigung'])),
  ohneText: await extract('ohne', buildTestPdf([null])),
  kaputt: await extract('kaputt', buildDamagedPdf()),
}));
`;

const scratch = await mkdtemp(join(tmpdir(), 'vorschicht-pdf-check-'));
let failures = 0;

function assert(label, ok, detail) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

try {
  const probePath = join(scratch, 'probe.mjs');
  await writeFile(probePath, probe);

  // 1. the binary, at the version the Dockerfile claims
  console.log(`· ${image}: poppler`);
  const version = await run('docker', ['run', '--rm', '--entrypoint', 'pdftotext', image, '-v']);
  // Measured: `pdftotext -v` writes to stderr and exits 0.
  const reported = `${version.stderr}${version.stdout}`.match(
    /pdftotext version ([0-9][0-9.]*)/,
  )?.[1];
  assert(
    `pdftotext antwortet und meldet ${expectedVersion}`,
    reported === expectedVersion,
    `gemeldet: ${reported ?? '(nichts)'}`,
  );

  // 2. the extractor, under the app service's real hardening
  console.log('· Extraktion unter read_only · cap_drop ALL · uid 10001 · ohne HOME');
  const hardened = await run('docker', [
    'run',
    '--rm',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '--user',
    '10001:10001',
    '--network',
    'none',
    '--volume',
    `${probePath}:/opt/probe.mjs:ro`,
    '--entrypoint',
    'node',
    image,
    '/opt/probe.mjs',
  ]);

  if (!hardened.ok) {
    assert('der Extraktor läuft unter den Härtungsflags', false, hardened.stderr.trim());
  } else {
    let answers = null;
    try {
      answers = JSON.parse(hardened.stdout.trim().split('\n').at(-1));
    } catch {
      assert('die Sonde antwortet in JSON', false, hardened.stdout.slice(0, 200));
    }
    if (answers) {
      assert(
        'ein PDF mit Textschicht liefert seinen Text',
        answers.mitText === 'Die Kuendigung erfolgt schriftlich',
        JSON.stringify(answers.mitText),
      );
      assert(
        'Umlaute überleben die Extraktion',
        answers.umlaut === 'Kündigung',
        JSON.stringify(answers.umlaut),
      );
      // The distinction the whole interface rests on, asserted in both
      // directions: `''` is "read, nothing in it", `null` is "not read".
      assert(
        'ein PDF ohne Textschicht liefert "" (gelesen, kein Text)',
        answers.ohneText === '',
        JSON.stringify(answers.ohneText),
      );
      assert(
        'eine kaputte Datei liefert null (nicht gelesen)',
        answers.kaputt === null,
        JSON.stringify(answers.kaputt),
      );
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

console.log('');
if (failures === 0) {
  console.log('check-pdf-extraction: alles grün.');
  exit(0);
}
console.error(`check-pdf-extraction: ${failures} Zusicherung(en) halten nicht.`);
exit(1);
