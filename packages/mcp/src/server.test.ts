/**
 * Drift between the three places a tool name appears.
 *
 * A tool the whitelist grants but the server does not register produces an
 * agent that sits there unable to do what it was asked; a tool the server
 * registers but no whitelist grants is dead weight that still costs context.
 * Neither fails loudly anywhere else, which is why this file exists.
 *
 * The protocol side — what a real MCP client actually sees over the wire — is
 * checked in `server.itest.ts`. This file checks the lists against each other,
 * with no database and no protocol.
 */
import { AGENT_PROFILES } from '@vorschicht/core';
import { MCP_TOOL_NAMES, type McpToolName } from '@vorschicht/shared';
import { describe, expect, it } from 'vitest';
import { askingDepartment, SERVER_TOOL_NAMES } from './server.js';

describe('Werkzeugliste des Servers', () => {
  it('registriert genau die Werkzeuge aus MCP_TOOLS — in beide Richtungen', () => {
    expect([...SERVER_TOOL_NAMES].sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });

  it('registriert jedes Werkzeug, das irgendein Rollenprofil erhält', () => {
    // The direction that matters operationally. A profile granting a name the
    // server never registers is the "idle agent" failure: the CLI accepts the
    // whitelist entry, the tool never appears, and nothing says why.
    const granted = new Set<McpToolName>();
    for (const profile of Object.values(AGENT_PROFILES)) {
      for (const tool of profile.mcpTools) granted.add(tool);
    }
    const registered = new Set(SERVER_TOOL_NAMES);
    const missing = [...granted].filter((tool) => !registered.has(tool));
    expect(missing).toEqual([]);
  });

  it('vergibt jeden Namen nur einmal', () => {
    expect(new Set(SERVER_TOOL_NAMES).size).toBe(SERVER_TOOL_NAMES.length);
  });
});

/**
 * §13s Rangfolge braucht die fragende Abteilung, und die hängt am Rollenprofil.
 *
 * Die Erwartungen stehen von Hand da statt aus `AGENT_PROFILES` berechnet: eine
 * Zusicherung, die ihre Erwartung aus der geprüften Sache ableitet, stimmt jeder
 * Änderung zu — dieselbe Überlegung wie bei `SERVER_TOOL_NAMES` einen Block
 * höher. Zwei Etiketten reichen; sie sind §8s Tabelle entnommen.
 */
describe('Abteilung der fragenden Sitzung (§13)', () => {
  it('liest §8s Abteilungsetikett aus dem Profil der Rolle', () => {
    expect(askingDepartment('coder')).toBe('Entwicklung');
    expect(askingDepartment('security')).toBe('Security');
  });

  it('antwortet auf eine unbekannte Rolle mit null, statt zu werfen', () => {
    // Fail *open*, und das ist hier die richtige Richtung: ohne Abteilung
    // liefert die Suche weiterhin jeden Treffer, nur ungewichtet (§13 — ein
    // Boost, keine Filterung). Eine Ausnahme an dieser Stelle beendet `main()`,
    // die CLI meldet den Server als `failed`, und die Sitzung verliert auch
    // `task.get_context` — A49s gemessener Ausfall, bezahlt für eine Frage nach
    // der Sortierreihenfolge.
    expect(askingDepartment('gibt-es-nicht')).toBeNull();
    expect(askingDepartment('')).toBeNull();
    // Und kein Treffer über die Prototypkette: `AGENT_PROFILES` ist ein
    // gewöhnliches Objekt, also beantwortet ein Nachschlagen von "constructor"
    // ohne diese Zusicherung eine Funktion statt einer Abteilung.
    expect(askingDepartment('constructor')).toBeNull();
    expect(askingDepartment('toString')).toBeNull();
  });
});
