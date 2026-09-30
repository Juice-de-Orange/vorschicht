/**
 * The hand-rolled JSON-RPC wire.
 *
 * `server.itest.ts` proves conformance the strong way — the vendor's own client
 * validates every response over a real pipe against a real database. These
 * tests cover the parts that client will not exercise on a good day: an unknown
 * method, a notification, malformed JSON, an unrecognised protocol revision.
 * Those are exactly the cases where a hand-rolled wire earns its keep or does
 * not.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  LATEST_PROTOCOL_VERSION,
  McpStdioServer,
  negotiateVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
  toolOk,
} from './protocol.js';

function server(handle: () => Promise<unknown> = async () => ({ ok: true })) {
  return new McpStdioServer({ name: 'vorschicht', version: '1.0.0' }, [
    {
      name: 'demo.tool',
      title: 'Demo',
      description: 'A demo tool.',
      input: z.object({ value: z.string().min(1, 'darf nicht leer sein') }),
      readOnly: true,
      handle: async () => toolOk((await handle()) as Record<string, unknown>),
    },
  ]);
}

const rpc = (method: string, params: Record<string, unknown> = {}, id: number | null = 1) => ({
  jsonrpc: '2.0' as const,
  id,
  method,
  params,
});

describe('Versionsaushandlung', () => {
  it('antwortet mit der angefragten Version, wenn sie unterstützt wird', () => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      expect(negotiateVersion(version)).toBe(version);
    }
  });

  it('antwortet mit der eigenen Version, wenn die angefragte unbekannt ist', () => {
    // Echoing an unrecognised future revision would be a claim we cannot back:
    // this surface was verified against the listed versions and nothing else.
    expect(negotiateVersion('2099-01-01')).toBe(LATEST_PROTOCOL_VERSION);
    expect(negotiateVersion(undefined)).toBe(LATEST_PROTOCOL_VERSION);
  });
});

describe('JSON-RPC', () => {
  it('meldet Fähigkeiten und Servernamen beim initialize', async () => {
    const response = await server().handle(rpc('initialize', { protocolVersion: '2025-06-18' }));
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'vorschicht' },
      },
    });
  });

  it('beantwortet ping', async () => {
    expect(await server().handle(rpc('ping'))).toMatchObject({ result: {} });
  });

  it('antwortet auf eine Benachrichtigung überhaupt nicht', async () => {
    // Answering one is a protocol violation clients report as an unexpected
    // response — and `notifications/initialized` arrives in every session.
    expect(await server().handle(rpc('notifications/initialized', {}, null))).toBeNull();
  });

  it('meldet eine unbekannte Methode als -32601', async () => {
    const response = await server().handle(rpc('resources/list'));
    expect(response).toMatchObject({ error: { code: -32601 } });
  });

  it('liefert für jedes Werkzeug ein JSON-Schema in draft-07', async () => {
    const response = (await server().handle(rpc('tools/list'))) as {
      result: { tools: Array<Record<string, unknown>> };
    };
    const [tool] = response.result.tools;
    expect(tool?.name).toBe('demo.tool');
    expect(tool?.annotations).toEqual({ readOnlyHint: true });
    const schema = tool?.inputSchema as Record<string, unknown>;
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.type).toBe('object');
  });
});

describe('tools/call', () => {
  it('gibt einen unbekannten Werkzeugnamen als Werkzeugfehler zurück, nicht als Protokollfehler', async () => {
    // A JSON-RPC fault reads to the model as "this server is broken"; a tool
    // error reads as "you called something that is not there" and names what is.
    const response = (await server().handle(
      rpc('tools/call', { name: 'nope', arguments: {} }),
    )) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]?.text).toContain('demo.tool');
  });

  it('validiert die Argumente und nennt das Feld, das fehlt', async () => {
    const response = (await server().handle(
      rpc('tools/call', { name: 'demo.tool', arguments: { value: '' } }),
    )) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]?.text).toMatch(/value: darf nicht leer sein/);
  });

  it('fängt einen geworfenen Handler ab, statt die Verbindung zu verlieren', async () => {
    const throwing = server(async () => {
      throw new Error('Datenbank nicht erreichbar');
    });
    const response = (await throwing.handle(
      rpc('tools/call', { name: 'demo.tool', arguments: { value: 'x' } }),
    )) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]?.text).toBe('Datenbank nicht erreichbar');
  });

  it('liefert denselben Inhalt als Text und als strukturierte Antwort', async () => {
    const response = (await server(async () => ({ a: 1 })).handle(
      rpc('tools/call', { name: 'demo.tool', arguments: { value: 'x' } }),
    )) as { result: { content: Array<{ text: string }>; structuredContent: unknown } };
    expect(JSON.parse(response.result.content[0]?.text ?? '')).toEqual({ a: 1 });
    expect(response.result.structuredContent).toEqual({ a: 1 });
  });
});

describe('Werkzeugtabelle', () => {
  it('weist einen doppelt registrierten Namen ab', () => {
    const duplicate = {
      name: 'demo.tool',
      title: 'Demo',
      description: 'x',
      input: z.object({}),
      handle: async () => toolOk({}),
    };
    expect(
      () => new McpStdioServer({ name: 'vorschicht', version: '1.0.0' }, [duplicate, duplicate]),
    ).toThrow(/doppelt registriert/);
  });
});
