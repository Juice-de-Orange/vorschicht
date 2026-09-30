/**
 * §16's SMTP path: "E-mail via SMTP (env-configured credentials): escalation
 * reminders, digests, and the weekly report."
 *
 * Four decisions in here are not transcription of §16.
 *
 *  1. **No SMTP library.** Nothing in this repository sends mail today, so the
 *     choice was a dependency or a client. What Vorschicht needs is one
 *     recipient, a handful of messages a day, one connection at a time — and
 *     what a client of that size buys is the thing a library takes away: the
 *     conversation can be driven against a real socket in a test, which is how
 *     `mail.test.ts` proves the EHLO/AUTH/MAIL/RCPT/DATA sequence rather than
 *     asserting that a mock was called. A49 made the same trade for the MCP wire
 *     and stated the same reason. The honest limit is recorded below: the TLS
 *     handshake itself is `node:tls`, and no test here exercises it.
 *
 *  2. **A password never crosses a cleartext socket.** If the connection is not
 *     already TLS and the server does not offer `STARTTLS`, a configured
 *     credential makes this refuse to send rather than authenticate in the
 *     clear. §19's posture, and the direction of the error is deliberate: a
 *     refused mail is a log line, a leaked mailbox password is the operator's mailbox.
 *     "Already TLS" is read off the socket (`encrypted`) and never off the
 *     `secure` flag: the flag records what was asked for, and the guarantee has
 *     to be about what was got.
 *
 *  3. **Sending never throws into a caller's control flow.** Same rule
 *     `Notifier` already follows and for a sharper reason: the callers are
 *     A13's reminder and digest, which run on a scheduler tick beside real work.
 *     A mail server that is down must not colour a task.
 *
 *  4. **An unconfigured SMTP is a state, not an error.** `.env.example` ships
 *     `SMTP_USER` and `SMTP_PASSWORD` empty, so the common case on a fresh
 *     installation is "no mail yet". `DisabledMailer` answers every send with
 *     the reason, once, and the caller logs it — the alternative, throwing at
 *     construction, would mean a studio that will not start because it cannot
 *     send an e-mail nobody is waiting for.
 */
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';
import type { MailContent } from '@vorschicht/shared';

export interface SmtpConfig {
  host: string;
  port: number;
  /** True for implicit TLS (465). False means plaintext, then STARTTLS if offered. */
  secure: boolean;
  user?: string | undefined;
  password?: string | undefined;
  /** `Vorschicht <vorschicht@…>` or a bare address. */
  from: string;
}

export interface OutgoingMail extends MailContent {
  to: string;
}

export type MailResult =
  | { ok: true }
  /** Nothing was attempted — SMTP is not configured. Never an error. */
  | { ok: false; skipped: true; error: string }
  | { ok: false; skipped: false; error: string };

export interface Mailer {
  /** True when a send would actually reach a server. */
  readonly enabled: boolean;
  send(mail: OutgoingMail): Promise<MailResult>;
}

/**
 * How this module reaches a socket, injectable so the tests can reach a fake.
 *
 * `upgrade` is separate from `connect` because the STARTTLS path is the one
 * shape a test cannot drive for real: a TLS server needs a certificate, and a
 * private key in this repository is exactly what `gate:secrets` exists to
 * refuse. So the test injects an identity upgrade and asserts the *protocol*
 * — that `STARTTLS` was issued and `EHLO` re-sent afterwards — while the actual
 * handshake stays `node:tls`. Stated rather than implied, because it is the one
 * branch here with no executed proof.
 */
export interface SmtpTransport {
  connect(options: { host: string; port: number; secure: boolean }): Promise<Duplex>;
  upgrade(socket: Duplex, host: string): Promise<Duplex>;
}

export const defaultSmtpTransport: SmtpTransport = {
  connect: ({ host, port, secure }) =>
    new Promise((resolve, reject) => {
      const socket = secure
        ? tlsConnect({ host, port, servername: host })
        : createConnection({ host, port });
      const onReady = (): void => {
        socket.removeListener('error', onError);
        resolve(socket);
      };
      const onError = (error: Error): void => {
        socket.removeListener(secure ? 'secureConnect' : 'connect', onReady);
        reject(error);
      };
      socket.once(secure ? 'secureConnect' : 'connect', onReady);
      socket.once('error', onError);
    }),
  upgrade: (socket, host) =>
    new Promise((resolve, reject) => {
      const secured = tlsConnect({ socket, servername: host });
      secured.once('secureConnect', () => resolve(secured));
      secured.once('error', reject);
    }),
};

/** Default wall clock for the whole conversation. A stuck server is a skipped mail. */
export const SMTP_TIMEOUT_MS = 20_000;

export interface SmtpMailerDeps {
  transport?: SmtpTransport | undefined;
  timeoutMs?: number | undefined;
  /** The name this client announces in EHLO. Never a secret, never a hostname lookup. */
  clientName?: string | undefined;
  /**
   * The clock the `Date:` header is stamped from, injected as everywhere else
   * in this project (`EscalationMailService`, `GuardianService`, `UsageMeter`).
   * A header nobody can pin to a known instant is a header no test can assert.
   */
  now?: (() => number) | undefined;
}

export class SmtpMailer implements Mailer {
  readonly enabled = true;
  private readonly transport: SmtpTransport;
  private readonly timeoutMs: number;
  private readonly clientName: string;
  private readonly now: () => number;

  constructor(
    private readonly config: SmtpConfig,
    deps: SmtpMailerDeps = {},
  ) {
    this.transport = deps.transport ?? defaultSmtpTransport;
    this.timeoutMs = deps.timeoutMs ?? SMTP_TIMEOUT_MS;
    this.clientName = deps.clientName ?? 'vorschicht';
    this.now = deps.now ?? Date.now;
  }

  async send(mail: OutgoingMail): Promise<MailResult> {
    try {
      await this.converse(mail);
      return { ok: true };
    } catch (error) {
      return { ok: false, skipped: false, error: (error as Error).message };
    }
  }

  private async converse(mail: OutgoingMail): Promise<void> {
    let socket = await this.transport.connect({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
    });
    let talk = new SmtpConversation(socket, this.timeoutMs);
    // Derived from the socket, never from the configuration. `secure` is what
    // the operator *asked* for; `encrypted` is what the connection turned out to
    // be, and §19's question is about the second. Reading the flag first
    // short-circuited the socket read entirely, so `SMTP_SECURE=true` against a
    // host answering plaintext on that port sent the mailbox password in base64
    // over cleartext — and reported success. Production is unchanged:
    // `defaultSmtpTransport.connect` uses `tlsConnect` exactly when `secure` is
    // set, and a `TLSSocket` is `encrypted`.
    let privateChannel = talk.encrypted;
    try {
      await talk.expect(220, await talk.read());
      let capabilities = await this.hello(talk);

      if (!privateChannel && capabilities.has('STARTTLS')) {
        await talk.command('STARTTLS', 220);
        talk.detach();
        socket = await this.transport.upgrade(socket, this.config.host);
        talk = new SmtpConversation(socket, this.timeoutMs);
        // Asked again of the socket the upgrade actually returned, rather than
        // assumed from the fact that one was asked for. Same rule as above, and
        // the reason `SmtpConversation` reads `encrypted` in its constructor.
        privateChannel = talk.encrypted;
        // The capability list before a TLS upgrade is not the list after it —
        // servers withhold AUTH until the channel is private, which is the whole
        // point. Re-asking is required by RFC 3207, not politeness.
        capabilities = await this.hello(talk);
      }

      await this.authenticate(talk, capabilities, privateChannel);
      await talk.command(`MAIL FROM:<${addressOf(this.config.from)}>`, 250);
      await talk.command(`RCPT TO:<${addressOf(mail.to)}>`, 250);
      await talk.command('DATA', 354);
      await talk.command(buildMessage(this.config.from, mail, { now: this.now }), 250);
      await talk.command('QUIT', 221).catch(() => {
        // The mail is accepted at the 250 above; a server that closes the
        // connection instead of answering QUIT has still taken it. Treating that
        // as a failure would make the reminder fire again tomorrow for a mail
        // that arrived.
      });
    } finally {
      talk.detach();
      socket.destroy();
    }
  }

  private async hello(talk: SmtpConversation): Promise<Set<string>> {
    const reply = await talk.command(`EHLO ${this.clientName}`, 250);
    return parseCapabilities(reply.lines);
  }

  private async authenticate(
    talk: SmtpConversation,
    capabilities: Set<string>,
    privateChannel: boolean,
  ): Promise<void> {
    const { user, password } = this.config;
    if (!user || !password) return;

    // Decision 2. A server that offers no encrypted channel gets no credential,
    // and the operator finds out from a message that names the fix.
    if (!privateChannel) {
      throw new Error(
        `SMTP-Server ${this.config.host}:${this.config.port} bietet kein STARTTLS an. ` +
          'Vorschicht sendet keine Zugangsdaten über eine unverschlüsselte Verbindung ' +
          '(§19) — setze SMTP_SECURE=true (Port 465) oder nimm einen Server mit STARTTLS.',
      );
    }

    const mechanisms = new Set(
      [...capabilities]
        .filter((capability) => capability.startsWith('AUTH'))
        .flatMap((capability) => capability.split(/\s+/).slice(1)),
    );

    if (mechanisms.has('PLAIN') || mechanisms.size === 0) {
      const credential = Buffer.from(`\0${user}\0${password}`, 'utf8').toString('base64');
      await talk.command(`AUTH PLAIN ${credential}`, 235);
      return;
    }
    if (mechanisms.has('LOGIN')) {
      await talk.command('AUTH LOGIN', 334);
      await talk.command(Buffer.from(user, 'utf8').toString('base64'), 334);
      await talk.command(Buffer.from(password, 'utf8').toString('base64'), 235);
      return;
    }
    throw new Error(
      `SMTP-Server ${this.config.host} bietet nur ${[...mechanisms].join(', ') || '(nichts)'} ` +
        'als Anmeldeverfahren an; Vorschicht beherrscht PLAIN und LOGIN.',
    );
  }
}

/**
 * The null object for an installation with no SMTP configured.
 *
 * It answers rather than throws, and it says which variables are missing —
 * "SMTP ist nicht konfiguriert" in a log at three in the morning is a sentence
 * that costs someone twenty minutes.
 */
export class DisabledMailer implements Mailer {
  readonly enabled = false;
  constructor(private readonly reason: string) {}

  async send(): Promise<MailResult> {
    return { ok: false, skipped: true, error: this.reason };
  }
}

/**
 * What `loadConfig` provides, as this module wants it. Every field optional,
 * because an installation without mail is a supported installation.
 */
export interface MailerSettings {
  smtpHost?: string | undefined;
  smtpPort?: number | undefined;
  smtpSecure?: boolean | undefined;
  smtpUser?: string | undefined;
  smtpPassword?: string | undefined;
  smtpFrom?: string | undefined;
}

/**
 * An `SmtpMailer` when the settings are complete, a `DisabledMailer` otherwise.
 *
 * "Complete" is host plus sender and nothing else: an anonymous relay on a
 * private network is a real arrangement, and demanding credentials would refuse
 * it. Credentials are checked where they are used, which is also where the
 * cleartext rule lives.
 */
/**
 * Which variables are missing before this settings set can send anything.
 *
 * Exported so §17.9's settings page can answer *why no mail arrives* from the
 * same rule that decides it, rather than from a second reading of the same two
 * fields. A page that derived "einsatzbereit" on its own would agree with
 * `createMailer` until somebody widened one of the two — A81's shape, and here
 * it would be wrong in the reassuring direction: the page would report a
 * channel as ready while `DisabledMailer` silently swallowed every reminder.
 *
 * Empty means ready. "Complete" is host plus sender and nothing else, for the
 * reason `createMailer` gives below.
 */
export function missingMailSettings(settings: MailerSettings): string[] {
  return [settings.smtpHost ? null : 'SMTP_HOST', settings.smtpFrom ? null : 'SMTP_FROM'].filter(
    (name): name is string => name !== null,
  );
}

export function createMailer(settings: MailerSettings, deps: SmtpMailerDeps = {}): Mailer {
  const missing = missingMailSettings(settings);

  if (missing.length > 0 || !settings.smtpHost || !settings.smtpFrom) {
    return new DisabledMailer(
      `SMTP ist nicht konfiguriert (${missing.join(', ')} fehlt) — es wird keine E-Mail ` +
        'versendet. §16s Benachrichtigungen laufen bis dahin nur über ntfy.',
    );
  }

  return new SmtpMailer(
    {
      host: settings.smtpHost,
      port: settings.smtpPort ?? 465,
      secure: settings.smtpSecure ?? true,
      user: settings.smtpUser || undefined,
      password: settings.smtpPassword || undefined,
      from: settings.smtpFrom,
    },
    deps,
  );
}

/**
 * What an EHLO answer offers, as a set that can be asked two questions.
 *
 * The first line of the reply is the greeting, never a capability. Each further
 * line arrives as `250-STARTTLS` or `250 AUTH PLAIN LOGIN`, so the four-character
 * status prefix comes off first — without that step every capability would read
 * as `250 …` and `has('STARTTLS')` would be false on a server that offers it,
 * which is the failure that silently sends a password in the clear. The set
 * holds both the whole line and its first word, so a caller can ask for
 * `STARTTLS` and for `AUTH` without knowing which shape it came in.
 */
export function parseCapabilities(replyLines: string[]): Set<string> {
  return new Set(
    replyLines
      .slice(1)
      .map((line) => line.slice(4).trim().toUpperCase())
      .filter((line) => line.length > 0)
      .flatMap((line) => [line, line.split(' ')[0] ?? '']),
  );
}

// --- the wire ----------------------------------------------------------------

export interface SmtpReply {
  code: number;
  lines: string[];
}

/**
 * One SMTP conversation over one socket.
 *
 * SMTP replies are line-oriented with a continuation marker (`250-` continues,
 * `250 ` ends), so a reply cannot be read as "one chunk" — a server is free to
 * split a multi-line EHLO response across TCP segments, and on a slow link it
 * does. Hence the buffer.
 */
class SmtpConversation {
  private buffer = '';
  private queue: SmtpReply[] = [];
  private waiter: ((reply: SmtpReply) => void) | null = null;
  private failed: Error | null = null;
  private rejecter: ((error: Error) => void) | null = null;
  private detached = false;
  readonly encrypted: boolean;

  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer += String(chunk);
    for (let index = this.buffer.indexOf('\r\n'); index >= 0; index = this.buffer.indexOf('\r\n')) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.absorb(line);
    }
  };

  private readonly onError = (error: Error): void => this.fail(error);
  private readonly onClose = (): void =>
    this.fail(new Error('SMTP-Verbindung wurde vom Server geschlossen'));

  private pendingLines: string[] = [];

  constructor(
    private readonly socket: Duplex,
    private readonly timeoutMs: number,
  ) {
    // `encrypted` is set by node:tls on a TLSSocket and absent on a plain one.
    // Read from the socket rather than from the config, so that the STARTTLS
    // branch tells the truth about the socket it actually ended up with.
    this.encrypted = (socket as Duplex & { encrypted?: boolean }).encrypted === true;
    socket.setEncoding('utf8');
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  /** Stop listening. Called before a TLS upgrade and once the exchange is over. */
  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
  }

  private absorb(line: string): void {
    this.pendingLines.push(line);
    // A continuation is `<code>-text`; the final line of a reply is `<code> text`
    // (or a bare code). Anything else is a server that is not speaking SMTP.
    if (line.length >= 4 && line[3] === '-') return;
    const code = Number.parseInt(line.slice(0, 3), 10);
    const reply: SmtpReply = { code, lines: this.pendingLines };
    this.pendingLines = [];
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      this.rejecter = null;
      resolve(reply);
    } else {
      this.queue.push(reply);
    }
  }

  private fail(error: Error): void {
    this.failed = error;
    const reject = this.rejecter;
    this.waiter = null;
    this.rejecter = null;
    reject?.(error);
  }

  async read(): Promise<SmtpReply> {
    const queued = this.queue.shift();
    if (queued) return queued;
    if (this.failed) throw this.failed;

    return new Promise<SmtpReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        this.rejecter = null;
        reject(new Error(`SMTP-Server antwortet nicht (${this.timeoutMs} ms)`));
      }, this.timeoutMs);
      this.waiter = (reply) => {
        clearTimeout(timer);
        resolve(reply);
      };
      this.rejecter = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  }

  /** Send a line (or the DATA payload) and require the expected reply code. */
  async command(line: string, expected: number): Promise<SmtpReply> {
    this.socket.write(`${line}\r\n`);
    return this.expect(expected, await this.read());
  }

  expect(expected: number, reply: SmtpReply): SmtpReply {
    if (reply.code !== expected) {
      throw new Error(
        `SMTP-Server antwortete ${reply.code}, erwartet war ${expected}: ` +
          reply.lines.join(' / '),
      );
    }
    return reply;
  }
}

// --- the message ---------------------------------------------------------------

/** `Vorschicht <a@b>` → `a@b`; a bare address is returned unchanged. */
export function addressOf(value: string): string {
  const angled = /<([^>]+)>/.exec(value);
  return (angled?.[1] ?? value).trim();
}

/**
 * What a caller may pin instead of leaving to chance.
 *
 * One object rather than three positional parameters, and all three serve the
 * same purpose the original `boundary` did: a message assembled from a random
 * boundary, the wall clock and a fresh UUID is a message no test can assert a
 * byte of. Production passes only the clock; the other two are the test's.
 */
export interface BuildMessageOptions {
  boundary?: string | undefined;
  now?: (() => number) | undefined;
  messageId?: string | undefined;
}

/**
 * A `multipart/alternative` message carrying both parts §16 requires.
 *
 * Both parts are base64 with `Content-Transfer-Encoding: base64`, which is the
 * one choice that makes the German content safe without a quoted-printable
 * encoder: no line runs past 76 characters, no umlaut arrives as a mojibake, and
 * no line of the payload can begin with a lone `.` (the base64 alphabet has no
 * dot), which is the transparency rule that eats the first character of a line
 * otherwise. The dot-stuffing pass below is still applied to the assembled
 * message, because the headers are not base64 and a costly mistake there is
 * silent.
 *
 * `Date` and `Message-ID` are here because this mail's entire job is to reach
 * the operator. RFC 5322 §3.6 makes `Date` and `From` the only mandatory fields and
 * `Message-ID` a SHOULD; SpamAssassin scores `MISSING_DATE` and `MISSING_MID`,
 * and a reminder that lands in a spam folder is a reminder that did not happen.
 * Header order is the conventional one, which costs nothing and is what a human
 * reading `View source` expects.
 */
export function buildMessage(
  from: string,
  mail: OutgoingMail,
  options: BuildMessageOptions = {},
): string {
  const separator = options.boundary ?? `=_vorschicht_${randomBoundary()}`;
  const now = options.now ?? Date.now;
  const lines = [
    `Date: ${rfc5322Date(now())}`,
    `From: ${from}`,
    `To: ${mail.to}`,
    `Subject: ${encodeHeaderWord(mail.subject)}`,
    `Message-ID: ${options.messageId ?? messageId(from)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${separator}"`,
    '',
    'Dies ist eine mehrteilige Nachricht im MIME-Format.',
    '',
    `--${separator}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    ...base64Lines(mail.text),
    '',
    `--${separator}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    ...base64Lines(mail.html),
    '',
    `--${separator}--`,
  ];
  return `${dotStuff(lines).join('\r\n')}\r\n.`;
}

/**
 * RFC 5321 §4.5.2 transparency: a payload line beginning with `.` gets a second
 * one, which the receiver strips.
 *
 * Recorded honestly, because otherwise this is the shape §8.2's sixth domain
 * looks for: **no input this module can currently produce reaches it.** Every
 * body line is base64 (the alphabet has no dot) and every header line begins
 * with a field name. It is kept and unit-tested rather than deleted because the
 * cost is one `map` and the failure it prevents is silent — a receiver eats the
 * first character of the line, only for content that happens to start with a
 * dot — and because the day someone switches the text part to quoted-printable
 * for deliverability, that content becomes reachable in one edit.
 */
export function dotStuff(lines: string[]): string[] {
  return lines.map((line) => (line.startsWith('.') ? `.${line}` : line));
}

function base64Lines(value: string): string[] {
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  const chunks: string[] = [];
  for (let index = 0; index < encoded.length; index += 76) {
    chunks.push(encoded.slice(index, index + 76));
  }
  return chunks.length > 0 ? chunks : [''];
}

/**
 * RFC 5322 §3.3 date-time, in UTC.
 *
 * `toUTCString()` produces exactly the right shape and then ends it in `GMT`,
 * which §4.3 admits only as an *obsolete* zone. Every parser still reads it —
 * but the reader this header exists for is a spam filter deciding how much a
 * message looks like mail, and `+0000` is the same instant written the way the
 * current grammar asks for it.
 *
 * Deliberately **not** `formatMoment` from `@vorschicht/shared`: that is `Intl`
 * German for a human reading the body (§2). A header is neither German nor for
 * a human, and sharing one formatter between the two would mean the next change
 * to the body's wording rewrites the envelope.
 */
export function rfc5322Date(ms: number): string {
  return new Date(ms).toUTCString().replace(/ GMT$/, ' +0000');
}

/**
 * A globally unique `Message-ID` (RFC 5322 §3.6.4).
 *
 * The right-hand side is the sender's own domain, which is what makes the id
 * unique without anyone coordinating. A `SMTP_FROM` that carries no usable
 * domain falls back to a reserved name (RFC 2606 `.invalid`) instead of
 * producing a malformed header or throwing out of `converse`: the id still has
 * the only property that matters, and a mail with an odd id arrives while a
 * mail that threw does not.
 */
function messageId(from: string): string {
  const domain = addressOf(from).split('@')[1] ?? '';
  // A space or an angle bracket in here would be a header the grammar refuses,
  // so a domain this narrow alphabet does not recognise counts as no domain.
  const host = /^[A-Za-z0-9.-]+$/.test(domain) ? domain : 'vorschicht.invalid';
  return `<${randomUUID()}@${host}>`;
}

/**
 * RFC 2047 for a header that is not pure ASCII.
 *
 * The same problem `Notifier.encodeHeader` solves for ntfy, and the same answer:
 * a German subject line is the norm here (§2), mail headers are ASCII, and an
 * unencoded umlaut reaches the operator as `erschÃ¶pft`.
 */
export function encodeHeaderWord(value: string): string {
  if (!/[^\x20-\x7E]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function randomBoundary(): string {
  return Math.random().toString(36).slice(2, 12);
}
