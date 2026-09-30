#!/usr/bin/env node
/**
 * Spike: where do the official rate-limit numbers actually come from? (A29)
 *
 *   node infra/scripts/spike-rate-limit.mjs [--out docs/adr/spike-raw.jsonl]
 *
 * A29 prescribed an evaluation order — stream-json result metadata, then
 * transcript JSONL fields, then the statusline mechanism. The first two were
 * already checked and neither carries `used_percentage`. This script settles
 * the remaining question by experiment rather than by reading:
 *
 *   1. Does `control_request { subtype: "get_usage" }` work over
 *      `--input-format stream-json` on the pinned CLI, and what shape comes back?
 *   2. Is `utilization` a percentage (0–100) or a fraction (0–1)? The whole
 *      budget guardian hangs on this: reading 0.85 as "0.85 percent used" means
 *      §7.2 never fires. It is settled by comparing the value against
 *      `rate_limit_event.status` and against a second reading taken after real
 *      token spend.
 *   3. Does `rate_limit_event` arrive unprompted in the stream, and does it
 *      carry enough to be a fallback?
 *
 * Costs one short real session. Everything observed is written verbatim so the
 * ADR quotes evidence rather than recollection.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { argv, exit } from 'node:process';

const outArg = argv.find((a) => a.startsWith('--out='))?.slice('--out='.length);
const OUT = outArg ?? '/tmp/vorschicht-spike-rate-limit.jsonl';
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, '');

/** @type {{controlResponses: unknown[], rateLimitEvents: unknown[], result: unknown}} */
const seen = { controlResponses: [], rateLimitEvents: [], result: null };

const child = spawn(
  'claude',
  [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    '1',
  ],
  { stdio: ['pipe', 'pipe', 'pipe'] },
);

const send = (obj) => {
  const line = `${JSON.stringify(obj)}\n`;
  appendFileSync(OUT, `>>> ${line}`);
  child.stdin.write(line);
};

let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let index;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard line-splitting loop
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    appendFileSync(OUT, `${line}\n`);
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'control_response') seen.controlResponses.push(event);
    else if (event.type === 'rate_limit_event') seen.rateLimitEvents.push(event);
    else if (event.type === 'result') seen.result = event;
  }
});

child.stderr.on('data', (chunk) => appendFileSync(OUT, `!!! ${chunk.toString()}`));

// 1) Ask for usage before any tokens are spent.
send({ type: 'control_request', request_id: 'spike-before', request: { subtype: 'get_usage' } });

// 2) Spend a little, so a second reading can be compared against the first.
setTimeout(() => {
  send({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Antworte mit genau einem Wort: ok' }],
    },
  });
}, 1500);

// 3) Ask again afterwards.
setTimeout(() => {
  send({ type: 'control_request', request_id: 'spike-after', request: { subtype: 'get_usage' } });
}, 20_000);

setTimeout(() => {
  try {
    child.stdin.end();
  } catch {
    /* already closed */
  }
}, 24_000);

const hardStop = setTimeout(() => child.kill('SIGKILL'), 90_000);

child.on('close', (code) => {
  clearTimeout(hardStop);
  console.log(`\nclaude beendet (exit ${code}). Rohprotokoll: ${OUT}\n`);

  console.log(`control_response: ${seen.controlResponses.length}`);
  for (const response of seen.controlResponses) {
    console.log(`  ${JSON.stringify(response).slice(0, 1200)}`);
  }

  console.log(`\nrate_limit_event: ${seen.rateLimitEvents.length}`);
  for (const event of seen.rateLimitEvents) {
    console.log(`  ${JSON.stringify(event.rate_limit_info ?? event)}`);
  }

  console.log('\nresult-Felder:');
  if (seen.result) {
    const keys = Object.keys(seen.result).sort();
    console.log(`  ${keys.join(', ')}`);
    console.log(`  enthält "rate_limit": ${JSON.stringify(seen.result).includes('rate_limit')}`);
    console.log(`  total_cost_usd: ${seen.result.total_cost_usd}`);
  } else {
    console.log('  (kein result-Objekt)');
  }

  // The verdict the ADR needs, stated as a fact rather than an impression.
  const utilizations = [];
  for (const response of seen.controlResponses) {
    const payload = response?.response?.response ?? response?.response;
    const limits = payload?.rate_limits;
    if (!limits) continue;
    for (const [window, value] of Object.entries(limits)) {
      if (value && typeof value === 'object' && 'utilization' in value) {
        utilizations.push([window, value.utilization]);
      }
    }
  }
  console.log('\nBeobachtete utilization-Werte:');
  if (utilizations.length === 0) {
    console.log('  keine — get_usage lieferte nichts Auswertbares');
  } else {
    for (const [window, value] of utilizations) console.log(`  ${window}: ${value}`);
    const max = Math.max(...utilizations.map(([, v]) => Number(v) || 0));
    console.log(
      max > 1
        ? '  → Skala ist eindeutig Prozent (0–100): ein Wert liegt über 1.'
        : '  → Alle Werte ≤ 1: Skala noch mehrdeutig, Kreuzprobe gegen den Token-Meter nötig.',
    );
  }
  exit(0);
});
