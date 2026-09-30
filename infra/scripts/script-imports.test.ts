import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every `await import()` of a file in these scripts goes through a `file://`
 * URL, never a bare path.
 *
 * **Why this is a rule and not a preference.** Node's ESM loader takes the
 * argument of `import()` as a *URL*, with a relative specifier as the only
 * concession. A POSIX absolute path survives that by accident — `/opt/x.js`
 * parses as a path-absolute URL and resolves against the base — so on Linux
 * `await import(join(REPO_ROOT, 'packages/db/dist/index.js'))` works and looks
 * correct forever. On Windows the same string is `C:\…`, which parses as a URL
 * with the scheme `c:`, and the loader refuses it:
 *
 *     Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with a scheme in:
 *     file, data, and node are supported … Received protocol 'c:'
 *
 * **Measured on 2026-08-17, and it was six scripts rather than one.** The
 * Betriebsprüfung (§8.2) could not start at all on the build machine — the one
 * department whose entire purpose is checking whether this studio's claims
 * about itself are true — and neither could `check-idle-audit.mjs` and
 * `check-radar-autotask.mjs`, which are the scripted verifications A38 requires
 * to *accompany* the two deferred Phase 6 gates. A deferred gate whose script
 * cannot run where it was written is A38's counterweight with nothing on it.
 *
 * This is A125/A127's class one layer over: there the finding was that a gate
 * step which never started was reported as a §11 blocker, and the answer was to
 * make the gate honest about it. Here the scripts do not start either, and
 * nothing at all reports it, because none of them runs inside `pnpm gate`.
 *
 * So the guard is mechanical (A44.3 — a rule that depends on everyone
 * remembering it is not a rule). `pathToFileURL` is the fix and it is
 * *platform-neutral*: it yields `file:///opt/…` on Linux and `file:///C:/…` on
 * Windows, so this is not a Windows port (A127.8) — it is one way of writing
 * the thing that is correct in both places, replacing one that happened to work
 * in a single one.
 *
 * Deliberately **not** flagged: a literal specifier (`'./sibling.mjs'`,
 * `'@playwright/test'`). Those are what `import()` is defined to take, and the
 * repository uses both. What may not appear is a computed absolute path.
 */

const scriptsDir = fileURLToPath(new URL('.', import.meta.url));

/**
 * The source with its comments blanked out, strings and regexes left alone.
 *
 * **Found by this guard firing on prose, 2026-08-18.** `audit-project.mjs`
 * documents the defect it exists to prevent, so its header contains the words
 * `await import()` — and the scanner below read that as a call with an empty
 * argument and reported a violation in a file that has no dynamic import at
 * all. That is A74.2's finding exactly, in the guard rather than in the
 * detector it was found in: *prose about a name counted as a use.* The cost is
 * not cosmetic — a guard that objects to documentation is a guard people learn
 * to work around, and this one protects a class that has already broken six
 * scripts once.
 *
 * Comments are blanked and **string and template literals are not**, because
 * unlike A74.2's tokeniser the payload here *is* a literal: the argument of
 * `import('./x.mjs')` is exactly what has to survive.
 *
 * The one genuine ambiguity in a character-level pass is `/` — comment or
 * regex. It is resolved the standard way, by what precedes it: a regex may only
 * begin where an expression may begin. Getting that wrong would be the
 * dangerous direction (a swallowed line could hide a real violation), so the
 * two anti-vacuity assertions below are what keep it honest — `inspected > 10`
 * proves the blanking did not eat the real imports, and the paired test proves
 * a violation is still caught in a file that also *talks* about one.
 */
function blankComments(source: string): string {
  let out = '';
  let i = 0;
  // What the previous meaningful character was, which is the only thing that
  // separates `/` as division from `/` as the start of a regex literal.
  let prev = '';
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < source.length) {
        out += source[i];
        if (source[i] === '\\') {
          i += 1;
          if (i < source.length) out += source[i];
          i += 1;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      prev = quote;
      continue;
    }
    // A regex literal may only start where an expression may start. Anything
    // else beginning with `/` is division, and division is never followed by
    // `/` or `*` (those were handled above), so this branch only has to keep
    // the regex body from being read as a comment or a string.
    if (c === '/' && (prev === '' || '([{=,:;!&|?+-*%~^<>'.includes(prev))) {
      out += c;
      i += 1;
      let inClass = false;
      while (i < source.length) {
        out += source[i];
        if (source[i] === '\\') {
          i += 1;
          if (i < source.length) out += source[i];
          i += 1;
          continue;
        }
        if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        else if (source[i] === '/' && !inClass) {
          i += 1;
          break;
        }
        i += 1;
      }
      prev = '/';
      continue;
    }
    out += c;
    // `c` is `string | undefined` under `noUncheckedIndexedAccess`, and the
    // loop condition already rules the miss out — an empty string keeps the
    // state machine honest either way rather than asserting it away.
    if (c !== undefined && !/\s/.test(c)) prev = c;
    i += 1;
  }
  return out;
}

/**
 * The argument text of every `await import(…)`, brackets balanced.
 *
 * A regular expression cannot do this: the argument is itself a call
 * (`pathToFileURL(join(REPO_ROOT, '…')).href`), it spans lines in four of the
 * six sites, and a lazy match would stop at the first `)` — which is inside the
 * argument. Counting brackets is the shortest thing that is actually right.
 */
function dynamicImportArguments(source: string): string[] {
  const needle = 'await import(';
  const found: string[] = [];
  let at = source.indexOf(needle);
  while (at !== -1) {
    let depth = 1;
    let i = at + needle.length;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') depth -= 1;
    }
    found.push(source.slice(at + needle.length, i - 1).trim());
    at = source.indexOf(needle, i);
  }
  return found;
}

/** A specifier `import()` is defined to accept: relative, or a package name. */
function isPlainSpecifier(argument: string): boolean {
  const literal = /^['"`](.*)$/s.exec(argument);
  if (!literal) return false;
  const body = literal[1];
  // The capture group is not optional in the pattern, but `strict` cannot see
  // that; treating an impossible miss as "not a plain specifier" fails closed.
  if (body === undefined) return false;
  // An absolute path in a literal is the same defect, only spelled out.
  if (body.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(body)) return false;
  return true;
}

describe('infra/scripts — dynamic imports', () => {
  it('resolves every computed module path through pathToFileURL', async () => {
    const files = (await readdir(scriptsDir)).filter((name) => name.endsWith('.mjs'));
    const violations: string[] = [];
    let inspected = 0;

    for (const file of files) {
      const source = blankComments(await readFile(join(scriptsDir, file), 'utf8'));
      for (const argument of dynamicImportArguments(source)) {
        inspected += 1;
        if (isPlainSpecifier(argument)) continue;
        if (argument.includes('pathToFileURL')) continue;
        violations.push(`${file}: await import(${argument.replace(/\s+/g, ' ')})`);
      }
    }

    expect(violations).toEqual([]);
    // Without this the assertion above passes on an empty corpus — a guard that
    // reads as covered and checks nothing (§8.2, domain 6).
    expect(inspected).toBeGreaterThan(10);
  });

  it('reads a nested, multi-line argument as one whole', () => {
    const source = [
      'const { a } = await import(',
      "  pathToFileURL(join(ROOT, 'x/y.js')).href",
      ');',
      "const { b } = await import('./sibling.mjs');",
    ].join('\n');

    expect(dynamicImportArguments(source)).toEqual([
      "pathToFileURL(join(ROOT, 'x/y.js')).href",
      "'./sibling.mjs'",
    ]);
  });

  it('refuses an absolute path even when it is spelled out as a literal', () => {
    expect(isPlainSpecifier("'./relative.mjs'")).toBe(true);
    expect(isPlainSpecifier("'@playwright/test'")).toBe(true);
    expect(isPlainSpecifier("'/opt/vorschicht/x.js'")).toBe(false);
    expect(isPlainSpecifier("'C:/Projekte/x.js'")).toBe(false);
  });

  it('liest Prosa über einen Import nicht als Import', () => {
    // The case that found this: a header documenting the defect the file exists
    // to prevent. Before `blankComments` this reported a violation in a file
    // with no dynamic import in it at all.
    const source = [
      '/**',
      ' * A130 fixed six scripts whose `await import()` took an absolute path.',
      ' */',
      "const x = 1; // and here await import(join(ROOT, 'y.js')) is only mentioned",
      'export const y = x;',
    ].join('\n');

    expect(dynamicImportArguments(blankComments(source))).toEqual([]);
  });

  it('findet den Verstoß trotzdem, wenn die Datei auch darüber redet', () => {
    // The paired direction, and the one that matters: blanking comments must not
    // become a way to hide a real defect. Prose *and* the genuine article in one
    // file — only the second may be reported.
    const source = [
      '// Erklärung: await import(REPO_ROOT) wäre falsch.',
      "const a = await import(join(REPO_ROOT, 'packages/db/dist/index.js'));",
      'export const b = a;',
    ].join('\n');

    expect(dynamicImportArguments(blankComments(source))).toEqual([
      "join(REPO_ROOT, 'packages/db/dist/index.js')",
    ]);
  });

  it('lässt Zeichenketten und reguläre Ausdrücke unangetastet', () => {
    // A stripper that mistook either for a comment could swallow the line a
    // real violation sits on — the dangerous direction, so it is pinned.
    const mitSchraegstrichen = `const u = 'https://example.org/a//b';`;
    expect(blankComments(mitSchraegstrichen)).toBe(mitSchraegstrichen);

    const regexMitAnfuehrung = `const r = /['"]/; const s = "danach";`;
    expect(blankComments(regexMitAnfuehrung)).toBe(regexMitAnfuehrung);

    const regexMitSchraegstrich = String.raw`const d = /^([A-Za-z]):[\\/]/;`;
    expect(blankComments(regexMitSchraegstrich)).toBe(regexMitSchraegstrich);
  });

  it('behält die Zeilenzahl, damit eine Fundstelle auffindbar bleibt', () => {
    const source = ['/* eins', '   zwei */', 'const x = 1;'].join('\n');
    expect(blankComments(source).split('\n')).toHaveLength(3);
    expect(blankComments(source).split('\n')[2]).toBe('const x = 1;');
  });
});
