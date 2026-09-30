/**
 * The MCP surface (§6.2, §6.4, §13).
 *
 * Two of these tests exist because of things the pinned CLI does silently. The
 * name substitution is one — a tool whose exposed name collides with another's
 * simply disappears, and the agent that was granted it sits there unable to see
 * it. The escalation shape is the other: §15's format is the entire studio-owner
 * promise, and the only place it can be enforced is at the boundary, because
 * the caller is a language model and a prompt is a request.
 */
import { describe, expect, it } from 'vitest';
import {
  assertNoWhitelistCollision,
  assessSessionTools,
  buildMcpServerConfig,
  ESCALATION_OPTION_RANGE,
  escalateAskInput,
  findingReportInput,
  MAX_NOTE_LENGTH,
  MCP_SERVER_NAME,
  MCP_TOOL_DESCRIPTIONS,
  MCP_TOOL_NAMES,
  MCP_TOOLS,
  type McpToolName,
  taskAppendNoteInput,
  whitelistName,
  whitelistNames,
} from './mcp-tools.js';

describe('Werkzeugnamen', () => {
  it('setzt Punkte in Unterstriche um — genau so, wie es die CLI tut', () => {
    // Verified against 2.1.220: a tool registered as `claims.list` reaches the
    // model as `mcp__vorschicht__claims_list`, and the tools/call that comes
    // back carries the original dotted name.
    expect(whitelistName('claims.list')).toBe('mcp__vorschicht__claims_list');
    expect(whitelistNames(['task.get_context', 'finding.report'])).toEqual([
      'mcp__vorschicht__task_get_context',
      'mcp__vorschicht__finding_report',
    ]);
  });

  it('erkennt zwei Werkzeuge, die denselben sichtbaren Namen ergäben', () => {
    // The failure this prevents was observed: three registered tools, two
    // visible, no warning anywhere.
    expect(() =>
      assertNoWhitelistCollision(['task.get_context', 'task_get_context'] as McpToolName[]),
    ).toThrow(/denselben sichtbaren Namen/);
  });

  it('hat für jedes Werkzeug eine Beschreibung', () => {
    // A tool without a description is a tool the model will not call, which is
    // indistinguishable from one that is broken.
    for (const name of MCP_TOOL_NAMES) {
      expect(MCP_TOOL_DESCRIPTIONS[name]?.length ?? 0).toBeGreaterThan(40);
    }
    expect(Object.keys(MCP_TOOL_DESCRIPTIONS).sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });

  it('kennt genau die sieben Werkzeuge aus §6.2/§13', () => {
    expect([...MCP_TOOL_NAMES].sort()).toEqual([
      'claims.list',
      'docs.get',
      'docs.search',
      'escalate.ask',
      'finding.report',
      'task.append_note',
      'task.get_context',
    ]);
    // Only three of them write, and one of those three is a note.
    const writers = MCP_TOOL_NAMES.filter((n) => !MCP_TOOLS[n].readOnly);
    expect(writers.sort()).toEqual(['escalate.ask', 'finding.report', 'task.append_note']);
  });
});

describe('escalate.ask (§15)', () => {
  const option = (title: string, recommended = false) => ({
    title,
    pros: ['Schnell umzusetzen'],
    cons: ['Weniger flexibel'],
    recommended,
  });

  it('nimmt eine vollständig vorbereitete Entscheidung an', () => {
    const parsed = escalateAskInput.parse({
      question: 'Sollen wir das Backup-Ziel auf 192.0.2.2 legen?',
      context: 'Die nächtliche Sicherung läuft, die Kopie außer Haus fehlt.',
      urgency: 'P1',
      options: [option('Auf 192.0.2.2 legen', true), option('Routing erweitern')],
    });
    expect(parsed.options).toHaveLength(2);
    expect(parsed.options.filter((o) => o.recommended)).toHaveLength(1);
  });

  it('weist eine einzelne Option ab — das ist eine Frage, keine Auswahl', () => {
    const result = escalateAskInput.safeParse({
      question: 'Was tun?',
      context: 'Kontext.',
      options: [option('Nur diese', true)],
    });
    expect(result.success).toBe(false);
  });

  it(`weist mehr als ${ESCALATION_OPTION_RANGE.max} Optionen ab`, () => {
    const result = escalateAskInput.safeParse({
      question: 'Was tun?',
      context: 'Kontext.',
      options: [option('A', true), option('B'), option('C'), option('D'), option('E')],
    });
    expect(result.success).toBe(false);
  });

  it('verlangt genau eine Empfehlung — keine ist eine Frage, zwei sind keine', () => {
    const none = escalateAskInput.safeParse({
      question: 'Was tun?',
      context: 'Kontext.',
      options: [option('A'), option('B')],
    });
    expect(none.success).toBe(false);
    expect(String(none.error)).toMatch(/Empfehlung/);

    const two = escalateAskInput.safeParse({
      question: 'Was tun?',
      context: 'Kontext.',
      options: [option('A', true), option('B', true)],
    });
    expect(two.success).toBe(false);
  });

  it('verlangt zu jeder Option Vor- und Nachteile', () => {
    // An option with no downside is a recommendation wearing an option's
    // clothes; §15 exists so the operator sees the trade-off, not the agent's taste.
    const result = escalateAskInput.safeParse({
      question: 'Was tun?',
      context: 'Kontext.',
      options: [
        { title: 'A', pros: ['gut'], cons: [], recommended: true },
        { title: 'B', pros: ['auch gut'], cons: ['teuer'] },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('finding.report (§11)', () => {
  it('nimmt einen relativen Pfad an', () => {
    const parsed = findingReportInput.parse({
      file: 'src/index.ts',
      line: 42,
      summary: 'Null-Prüfung fehlt',
    });
    expect(parsed.line).toBe(42);
  });

  it('weist absolute Pfade und Ausbrüche ab', () => {
    // The same rule the claim grammar enforces, for the same reason: a finding
    // pointing at /etc/passwd is either a defect in the agent or an attempt.
    expect(findingReportInput.safeParse({ file: '/etc/passwd', summary: 'x' }).success).toBe(false);
    expect(findingReportInput.safeParse({ file: '../andere/datei.ts', summary: 'x' }).success).toBe(
      false,
    );
  });

  it('kennt keine Schwere — jeder Fund ist ein Blocker', () => {
    const parsed = findingReportInput.parse({ file: 'a.ts', summary: 'x', severity: 'warning' });
    expect('severity' in parsed).toBe(false);
  });
});

describe('task.append_note', () => {
  it('weist leere Notizen ab und deckelt die Länge', () => {
    expect(taskAppendNoteInput.safeParse({ text: '' }).success).toBe(false);
    expect(taskAppendNoteInput.safeParse({ text: 'x'.repeat(MAX_NOTE_LENGTH) }).success).toBe(true);
    expect(taskAppendNoteInput.safeParse({ text: 'x'.repeat(MAX_NOTE_LENGTH + 1) }).success).toBe(
      false,
    );
  });
});

describe('Hat die Sitzung ihre Werkzeuge bekommen? (§6.2)', () => {
  const connected = {
    mcpServers: [{ name: MCP_SERVER_NAME, status: 'connected' }],
    tools: ['Read', ...whitelistNames(['task.get_context', 'claims.list'])],
  };

  it('ist zufrieden, wenn der Server verbunden ist und die Werkzeuge da sind', () => {
    expect(assessSessionTools(connected, ['task.get_context', 'claims.list'])).toEqual({
      ok: true,
    });
  });

  it('erkennt einen Server, der beim Start noch "pending" meldete', () => {
    // Verified against the pinned CLI with a deliberately slow server: the
    // first turn then has none of these tools, and the model reports that it
    // can do nothing. Retrying is right; marking the task red is not (A25).
    const verdict = assessSessionTools(
      { mcpServers: [{ name: MCP_SERVER_NAME, status: 'pending' }], tools: ['Read'] },
      ['task.get_context'],
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.problem).toMatch(/pending/);
  });

  it('erkennt einen Server, der gar nicht auftaucht', () => {
    const verdict = assessSessionTools({ mcpServers: [], tools: [] }, ['task.get_context']);
    expect(verdict.ok).toBe(false);
  });

  it('erkennt ein einzelnes fehlendes Werkzeug', () => {
    const verdict = assessSessionTools(connected, ['task.get_context', 'finding.report']);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.problem).toContain('mcp__vorschicht__finding_report');
  });

  it('lässt eine Rolle ohne MCP-Werkzeuge in Ruhe', () => {
    // Staff roles in later phases may legitimately have none; demanding a
    // connected server from them would fail runs that never needed one.
    expect(assessSessionTools({ mcpServers: [], tools: [] }, [])).toEqual({ ok: true });
  });
});

describe('--mcp-config (§6.2, §19)', () => {
  const config = buildMcpServerConfig({
    command: 'node',
    args: ['/app/packages/mcp/dist/main.js'],
    taskId: 'task-1',
    runId: 'run-1',
    role: 'coder',
  });

  it('nennt den Server so, wie die Whitelist ihn adressiert', () => {
    expect(Object.keys(config.mcpServers)).toEqual([MCP_SERVER_NAME]);
  });

  it('gibt der Sitzung ihre Identität mit', () => {
    const env = config.mcpServers[MCP_SERVER_NAME]?.env ?? {};
    expect(env.VORSCHICHT_TASK_ID).toBe('task-1');
    expect(env.VORSCHICHT_RUN_ID).toBe('run-1');
    expect(env.VORSCHICHT_ROLE).toBe('coder');
  });

  it('enthält kein Geheimnis — die Datei ist nicht der Ort dafür (§19)', () => {
    // DATABASE_URL is inherited from the orchestrator; the CLI merges this env
    // over the parent's rather than replacing it (verified on 2.1.220).
    const serialised = JSON.stringify(config);
    expect(serialised).not.toMatch(/postgres:\/\//);
    expect(serialised).not.toMatch(/sk-ant/);
    expect(serialised).not.toMatch(/DATABASE_URL/);
  });

  it('löscht den OAuth-Token für den Kindprozess', () => {
    // Blanking works: an empty value in this block reaches the child as an
    // empty string. The MCP server talks to Postgres, never to Anthropic, so a
    // process that cannot spend the subscription is one fewer that might.
    expect(config.mcpServers[MCP_SERVER_NAME]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
  });
});
