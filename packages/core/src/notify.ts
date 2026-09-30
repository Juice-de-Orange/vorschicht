/**
 * ntfy push notifications (§16).
 *
 * All user-facing text is German (§2). There are no quiet hours — §16 is
 * explicit that everything pushes immediately, 24/7 — so this module has no
 * scheduling logic at all, on purpose.
 *
 * Delivery is best-effort and never throws into a caller's control flow: a
 * failed push must not turn a healthy task red. Failures are surfaced as a
 * returned result so the caller can log them and, where it matters (alerts),
 * fall back to the event log.
 */
import { NTFY_TOPICS, type NtfyTopic } from '@vorschicht/shared';

export interface NotifyConfig {
  server: string;
  token: string;
  topics?: Partial<Record<NtfyTopic, string>>;
}

export type NotifyPriority = 'min' | 'low' | 'default' | 'high' | 'urgent';

export interface Notification {
  topic: NtfyTopic;
  title: string;
  message: string;
  priority?: NotifyPriority;
  tags?: string[];
  /** Deep link straight to the item, per §15. */
  clickUrl?: string;
}

export type NotifyResult =
  | { ok: true; status: number }
  | { ok: false; status: number | null; error: string };

export class Notifier {
  constructor(
    private readonly config: NotifyConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private topicName(topic: NtfyTopic): string {
    return this.config.topics?.[topic] ?? NTFY_TOPICS[topic];
  }

  async send(notification: Notification, timeoutMs = 8000): Promise<NotifyResult> {
    const url = `${this.config.server.replace(/\/+$/, '')}/${this.topicName(notification.topic)}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.token}`,
      Title: encodeHeader(notification.title),
      Priority: notification.priority ?? 'default',
    };
    if (notification.tags?.length) headers.Tags = notification.tags.join(',');
    if (notification.clickUrl) headers.Click = notification.clickUrl;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: notification.message,
        signal: controller.signal,
      });
      return response.ok
        ? { ok: true, status: response.status }
        : { ok: false, status: response.status, error: `ntfy antwortete ${response.status}` };
    } catch (error) {
      return { ok: false, status: null, error: (error as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * ntfy sends headers over HTTP/1.1, which is latin-1 only. German umlauts in a
 * title would otherwise either throw or arrive as mojibake — so non-ASCII is
 * RFC 2047 encoded, which ntfy clients decode correctly.
 */
function encodeHeader(value: string): string {
  if (!/[^\x20-\x7E]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}
