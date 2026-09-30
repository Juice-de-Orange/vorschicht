/**
 * Server-sent events hub (§4, §17).
 *
 * One Postgres LISTEN connection for the whole process, fanning out to every
 * connected dashboard. A connection per client would work fine for one user and
 * then quietly exhaust the pool the first time someone leaves four tabs open.
 *
 * Three details that decide whether "realtime" actually feels realtime:
 *
 *  * **Catch-up by id, not by timestamp.** A reconnecting client sends
 *    `Last-Event-ID`; two events can share a millisecond, an id cannot.
 *  * **A heartbeat comment every 25 s.** nginx has `proxy_read_timeout 24h` for
 *    this location, but phones suspend radios and NAT tables forget; a periodic
 *    comment keeps the connection observably alive and lets the browser notice
 *    a dead one quickly.
 *  * **The payload is fetched, not carried.** The NOTIFY message holds only
 *    identifiers (see migration 0005), so the hub reads the row — the same path
 *    catch-up uses, which means live and replayed events cannot drift apart.
 */
import type { EventLog, EventRow } from '@vorschicht/core';
import { EVENT_CHANNEL, parseEventNotification } from '@vorschicht/core';
import type postgres from 'postgres';

const HEARTBEAT_MS = 25_000;
const SNAPSHOT_SIZE = 100;

interface Client {
  id: number;
  send: (chunk: string) => void;
  close: () => void;
}

export interface SseHubDeps {
  /** A dedicated connection: LISTEN occupies it for the process's lifetime. */
  listener: postgres.Sql;
  eventLog: EventLog;
  onError?: (error: unknown) => void;
}

export class SseHub {
  private readonly clients = new Map<number, Client>();
  private nextClientId = 1;
  private heartbeat: NodeJS.Timeout | null = null;
  private unlisten: (() => Promise<void>) | null = null;

  constructor(private readonly deps: SseHubDeps) {}

  get clientCount(): number {
    return this.clients.size;
  }

  async start(): Promise<void> {
    const subscription = await this.deps.listener.listen(EVENT_CHANNEL, (raw) => {
      const notification = parseEventNotification(raw);
      if (!notification) return;
      void this.deps.eventLog
        .byId(notification.id)
        .then((event) => {
          if (event) this.broadcast(event);
        })
        .catch((error) => this.deps.onError?.(error));
    });
    this.unlisten = subscription.unlisten;

    this.heartbeat = setInterval(() => {
      // A comment line: valid SSE, ignored by EventSource, keeps the pipe warm.
      for (const client of this.clients.values()) client.send(`: ping ${Date.now()}\n\n`);
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
    await this.unlisten?.();
    this.unlisten = null;
  }

  private broadcast(event: EventRow): void {
    const frame = formatEvent(event);
    for (const client of this.clients.values()) client.send(frame);
  }

  /**
   * Build the SSE response for one client.
   *
   * `lastEventId` comes from the `Last-Event-ID` header the browser resends
   * automatically on reconnect, or from a query parameter for callers that
   * cannot set headers.
   */
  handle(lastEventId: string | null): Response {
    const id = this.nextClientId++;
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        let closed = false;
        const client: Client = {
          id,
          send: (chunk) => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(chunk));
            } catch {
              // The client vanished between the check and the write.
              closed = true;
              this.clients.delete(id);
            }
          },
          close: () => {
            if (closed) return;
            closed = true;
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          },
        };

        // Tell the browser to wait a moment before reconnecting, so a restart
        // does not turn into a stampede.
        client.send('retry: 3000\n\n');

        try {
          const backlog = lastEventId
            ? await this.deps.eventLog.since(lastEventId)
            : (await this.deps.eventLog.recent(SNAPSHOT_SIZE)).reverse();
          for (const event of backlog) client.send(formatEvent(event));
          // Marks the end of the replay so the UI can stop showing "syncing".
          client.send(`event: synced\ndata: ${JSON.stringify({ count: backlog.length })}\n\n`);
        } catch (error) {
          this.deps.onError?.(error);
          client.send(
            `event: error\ndata: ${JSON.stringify({ message: 'Verlauf nicht ladbar' })}\n\n`,
          );
        }

        this.clients.set(id, client);
      },
      cancel: () => {
        this.clients.delete(id);
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Belt and braces alongside the nginx location: if this ever ends up
        // behind a proxy nobody configured, the header still asks it not to
        // buffer, and a buffered SSE stream is indistinguishable from a hang.
        'x-accel-buffering': 'no',
      },
    });
  }
}

export function formatEvent(event: EventRow): string {
  const data = {
    id: event.id,
    at: event.occurredAt.toISOString(),
    kind: event.kind,
    actor: event.actor,
    projectId: event.projectId,
    taskId: event.taskId,
    runId: event.runId,
    payload: event.payload,
  };
  return `id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(data)}\n\n`;
}
