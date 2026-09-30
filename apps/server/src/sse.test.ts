import type { EventLog, EventRow } from '@vorschicht/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatEvent, SseHub } from './sse.js';

function row(id: string, kind = 'run.started'): EventRow {
  return {
    id,
    occurredAt: new Date('2026-08-01T05:00:00.000Z'),
    kind,
    actor: 'system',
    projectId: null,
    taskId: null,
    runId: null,
    deployId: null,
    payload: { note: 'ümlaut' },
  };
}

/** Minimal stand-in for a dedicated LISTEN connection. */
function fakeListener() {
  let handler: ((raw: string) => void) | null = null;
  return {
    sql: {
      listen: async (_channel: string, cb: (raw: string) => void) => {
        handler = cb;
        return { unlisten: async () => {} };
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal stand-in for postgres.Sql
    } as any,
    emit: (raw: string) => handler?.(raw),
  };
}

function fakeEventLog(rows: EventRow[]): EventLog {
  return {
    recent: vi.fn(async (limit: number) => rows.slice(-limit).reverse()),
    since: vi.fn(async (afterId: string) => rows.filter((r) => Number(r.id) > Number(afterId))),
    byId: vi.fn(async (id: string) => rows.find((r) => r.id === id) ?? null),
    // biome-ignore lint/suspicious/noExplicitAny: only the read side is exercised here
  } as any;
}

async function readFrames(response: Response, count: number, timeoutMs = 2000): Promise<string[]> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (frames.length < count && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      frames.push(buffer.slice(0, index + 2));
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf('\n\n');
    }
  }
  void reader.cancel();
  return frames;
}

describe('formatEvent', () => {
  it('emits a well-formed SSE frame with the id as the SSE id', () => {
    const frame = formatEvent(row('42'));
    expect(frame).toMatch(/^id: 42\n/);
    expect(frame).toContain('event: run.started\n');
    expect(frame.endsWith('\n\n')).toBe(true);
    const data = JSON.parse(frame.split('data: ')[1] as string);
    expect(data.id).toBe('42');
    expect(data.payload.note).toBe('ümlaut');
  });

  // A payload containing a newline would otherwise split the frame and corrupt
  // every subsequent event on the stream.
  it('survives newlines in the payload', () => {
    const nasty = { ...row('7'), payload: { text: 'zeile1\nzeile2\n\nabsatz' } };
    const frame = formatEvent(nasty);
    expect(frame.split('\n\n')).toHaveLength(2);
    const data = JSON.parse(frame.split('data: ')[1] as string);
    expect(data.payload.text).toBe('zeile1\nzeile2\n\nabsatz');
  });
});

describe('SseHub', () => {
  let hub: SseHub | null = null;
  afterEach(async () => {
    await hub?.stop();
    hub = null;
  });

  it('sends a snapshot then marks the replay as complete', async () => {
    const listener = fakeListener();
    hub = new SseHub({ listener: listener.sql, eventLog: fakeEventLog([row('1'), row('2')]) });
    await hub.start();

    const frames = await readFrames(hub.handle(null), 4);
    expect(frames[0]).toContain('retry: 3000');
    // Oldest first, so the UI can append rather than sort.
    expect(frames[1]).toMatch(/^id: 1\n/);
    expect(frames[2]).toMatch(/^id: 2\n/);
    expect(frames[3]).toContain('event: synced');
  });

  // The reconnect path §17 asks for: catching up by id, because two events can
  // share a millisecond and an id cannot.
  it('replays only what a reconnecting client missed', async () => {
    const listener = fakeListener();
    const log = fakeEventLog([row('1'), row('2'), row('3')]);
    hub = new SseHub({ listener: listener.sql, eventLog: log });
    await hub.start();

    const frames = await readFrames(hub.handle('2'), 3);
    expect(log.since).toHaveBeenCalledWith('2');
    expect(frames.filter((f) => f.startsWith('id: '))).toHaveLength(1);
    expect(frames[1]).toMatch(/^id: 3\n/);
  });

  it('fans a notification out to every connected client', async () => {
    const listener = fakeListener();
    hub = new SseHub({
      listener: listener.sql,
      eventLog: fakeEventLog([row('9', 'task.created')]),
    });
    await hub.start();

    // Readers are kept open on purpose: cancelling one unsubscribes it, which
    // would make this test pass for the wrong reason.
    const readers = [hub.handle('99'), hub.handle('99')].map((response) =>
      (response.body as ReadableStream<Uint8Array>).getReader(),
    );
    const decoder = new TextDecoder();
    for (const reader of readers) {
      // Drain the connect frames (retry + synced).
      await reader.read();
    }
    expect(hub.clientCount).toBe(2);

    listener.emit(JSON.stringify({ id: '9', kind: 'task.created' }));

    for (const reader of readers) {
      let text = '';
      const deadline = Date.now() + 2000;
      while (!text.includes('task.created') && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      expect(text).toContain('event: task.created');
      expect(text).toContain('"id":"9"');
      void reader.cancel();
    }
  });

  it('ignores an unparseable notification instead of dying', async () => {
    const listener = fakeListener();
    const onError = vi.fn();
    hub = new SseHub({ listener: listener.sql, eventLog: fakeEventLog([]), onError });
    await hub.start();
    expect(() => listener.emit('kein json')).not.toThrow();
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a snapshot failure to the client rather than hanging', async () => {
    const listener = fakeListener();
    const onError = vi.fn();
    const broken = {
      recent: async () => {
        throw new Error('db weg');
      },
      since: async () => [],
      byId: async () => null,
      // biome-ignore lint/suspicious/noExplicitAny: deliberately broken stand-in
    } as any;
    hub = new SseHub({ listener: listener.sql, eventLog: broken, onError });
    await hub.start();

    const frames = await readFrames(hub.handle(null), 2);
    expect(frames.some((f) => f.includes('event: error'))).toBe(true);
    expect(onError).toHaveBeenCalled();
  });

  it('drops a client that cancels its stream', async () => {
    const listener = fakeListener();
    hub = new SseHub({ listener: listener.sql, eventLog: fakeEventLog([row('1')]) });
    await hub.start();

    const response = hub.handle(null);
    const reader = (response.body as ReadableStream).getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hub.clientCount).toBe(0);
  });
});
