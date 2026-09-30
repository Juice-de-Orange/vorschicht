/**
 * The SMTP client, driven against a **real socket** rather than a mock.
 *
 * That is the whole reason this client exists instead of a dependency (see
 * `mail.ts`, decision 1): a fake server on localhost lets the test assert the
 * conversation that will happen on the production host — EHLO, AUTH, MAIL FROM, RCPT TO,
 * DATA, the dot that terminates it — and read the bytes that arrive. A stubbed
 * library would assert that a method was called with an object.
 *
 * Stated scope limit, because it is the one branch with no executed proof: the
 * TLS handshake is `node:tls` and is not exercised here. A TLS test needs a
 * certificate, and a private key in this repository is exactly what
 * `gate:secrets` refuses. What *is* proved about the STARTTLS path is the
 * protocol around it — the command is issued, the upgrade is asked for, EHLO is
 * repeated afterwards — with an identity upgrade injected in place of `tls`.
 */
import { once } from 'node:events';
import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addressOf,
  buildMessage,
  createMailer,
  DisabledMailer,
  defaultSmtpTransport,
  dotStuff,
  encodeHeaderWord,
  parseCapabilities,
  rfc5322Date,
  type SmtpConfig,
  SmtpMailer,
  type SmtpTransport,
} from './mail.js';

/** What the fake server said and heard, so a test can assert on the real bytes. */
interface Recording {
  server: Server;
  port: number;
  lines: string[];
  /** Everything between DATA and the terminating dot, unparsed. */
  payload: string;
}

interface FakeOptions {
  /** EHLO capability lines, without the `250-` prefix. */
  capabilities?: string[];
  /** Reply with this code instead of 250 for the named command verb. */
  reject?: { verb: string; code: number; text: string };
  /** Close the socket without answering QUIT — a real and common server habit. */
  rudeQuit?: boolean;
}

/**
 * A server that speaks just enough SMTP to be wrong in the interesting ways.
 *
 * Deliberately not a general implementation: it records verbatim and answers by
 * verb, so a client that sent the right commands in the wrong order, or skipped
 * one, produces a recording that does not match.
 */
async function fakeSmtp(options: FakeOptions = {}): Promise<Recording> {
  const capabilities = options.capabilities ?? ['AUTH PLAIN LOGIN'];
  const recording: Partial<Recording> & { lines: string[]; payload: string } = {
    lines: [],
    payload: '',
  };

  const server = createServer((socket: Socket) => {
    let inData = false;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.write('220 fake.local ESMTP\r\n');

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let at = buffer.indexOf('\r\n'); at >= 0; at = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 2.0.0 Ok: queued\r\n');
          } else {
            recording.payload += `${line}\n`;
          }
          continue;
        }

        recording.lines.push(line);
        const verb = line.split(' ')[0]?.toUpperCase() ?? '';
        if (options.reject?.verb === verb) {
          socket.write(`${options.reject.code} ${options.reject.text}\r\n`);
          continue;
        }
        if (verb === 'EHLO') {
          const all = ['fake.local greets you', ...capabilities];
          for (const [index, text] of all.entries()) {
            socket.write(`250${index === all.length - 1 ? ' ' : '-'}${text}\r\n`);
          }
        } else if (verb === 'STARTTLS') {
          socket.write('220 2.0.0 Ready to start TLS\r\n');
        } else if (verb === 'AUTH') {
          // `AUTH LOGIN` asks for the username, then the password; `AUTH PLAIN`
          // carries both on the one line. Both shapes end at 235.
          socket.write(
            line.toUpperCase().includes('LOGIN') ? '334 VXNlcm5hbWU6\r\n' : '235 Ok\r\n',
          );
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 End data with <CRLF>.<CRLF>\r\n');
        } else if (verb === 'QUIT') {
          if (options.rudeQuit) socket.destroy();
          else socket.write('221 Bye\r\n');
        } else if (/^[A-Za-z0-9+/=]+$/.test(line)) {
          // A bare base64 line is an `AUTH LOGIN` continuation. The first is the
          // username (ask again), the second is the password (accept).
          const seen = recording.lines.filter((l) => /^[A-Za-z0-9+/=]+$/.test(l)).length;
          socket.write(seen >= 2 ? '235 Ok\r\n' : '334 UGFzc3dvcmQ6\r\n');
        } else {
          socket.write('250 Ok\r\n');
        }
      }
    });
    socket.on('error', () => undefined);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return Object.assign(recording, { server, port }) as Recording;
}

let running: Recording | null = null;

afterEach(async () => {
  running?.server.close();
  running = null;
});

async function start(options: FakeOptions = {}): Promise<Recording> {
  running = await fakeSmtp(options);
  return running;
}

const MAIL = {
  to: 'max@example.org',
  subject: 'Entscheidung #12 wartet seit 26 Stunden',
  text: 'Frage: Darf Vorschicht das?\n.punkt am zeilenanfang\n',
  html: '<p>Frage: Darf Vorschicht das?</p>',
};

/**
 * Stands in for "the socket is already private" without a certificate.
 *
 * `secure: true` would otherwise send the production transport into a real TLS
 * handshake against a plaintext fake, which tests `node:tls` and nothing else.
 * The plaintext cases below deliberately use `defaultSmtpTransport` unmodified,
 * so the shipped `connect` really is the thing under test there.
 */
const alreadyPrivate: SmtpTransport = {
  connect: async ({ host, port }) =>
    // A plain socket standing in for a TLS one, and saying so where the client
    // reads it. `TLSSocket.encrypted` is what `defaultSmtpTransport` produces
    // here in production; a stand-in that omitted it would be a stand-in for
    // something else.
    Object.assign(await defaultSmtpTransport.connect({ host, port, secure: false }), {
      encrypted: true,
    }),
  upgrade: async (socket) => socket,
};

/**
 * A transport that connects in cleartext while the configuration claims TLS.
 *
 * Not a fault to inject so much as the honest shape of a misconfiguration: an
 * operator who set `SMTP_SECURE=true` against a host that answers plaintext on
 * that port. The flag says private, the socket is not, and §19 has to follow
 * the socket.
 */
const claimsPrivate: SmtpTransport = {
  connect: ({ host, port }) => defaultSmtpTransport.connect({ host, port, secure: false }),
  upgrade: async (socket) => socket,
};

/** A fixed instant, so the `Date:` header on the wire is an exact assertion. */
const CLOCK = Date.UTC(2026, 7, 2, 6, 5, 4);

function mailer(
  port: number,
  extra: Partial<SmtpConfig> = {},
  transport?: SmtpTransport,
): SmtpMailer {
  return new SmtpMailer(
    {
      host: '127.0.0.1',
      port,
      secure: false,
      from: 'Vorschicht <vorschicht-bot@example.com>',
      ...extra,
    },
    { timeoutMs: 5_000, clientName: 'vorschicht.test', transport, now: () => CLOCK },
  );
}

describe('SmtpMailer against a real socket', () => {
  it('drives the whole conversation in order and delivers both parts', async () => {
    const fake = await start({ capabilities: [] });
    const result = await mailer(fake.port).send(MAIL);

    expect(result).toEqual({ ok: true });
    expect(fake.lines).toEqual([
      'EHLO vorschicht.test',
      'MAIL FROM:<vorschicht-bot@example.com>',
      'RCPT TO:<max@example.org>',
      'DATA',
      'QUIT',
    ]);

    // §16 asks for both parts, and this is the assertion that they arrived —
    // the bytes the server received, not the object the renderer produced.
    expect(fake.payload).toContain('Content-Type: multipart/alternative');
    expect(fake.payload).toContain('Content-Type: text/plain; charset=utf-8');
    expect(fake.payload).toContain('Content-Type: text/html; charset=utf-8');
    const parts = fake.payload
      .split('\n')
      .filter((line) => /^[A-Za-z0-9+/=]{20,}$/.test(line))
      .map((line) => Buffer.from(line, 'base64').toString('utf8'));
    expect(parts.some((part) => part.includes('Darf Vorschicht das?'))).toBe(true);
    expect(parts.some((part) => part.startsWith('<p>'))).toBe(true);
  });

  it('encodes a subject with umlauts so it is not mojibake in the mailbox', async () => {
    const fake = await start({ capabilities: [] });
    await mailer(fake.port).send({ ...MAIL, subject: 'Wochenbudget erschöpft' });
    const line = fake.payload.split('\n').find((l) => l.startsWith('Subject:')) ?? '';
    expect(line).toBe('Subject: =?UTF-8?B?V29jaGVuYnVkZ2V0IGVyc2Now7ZwZnQ=?=');
    expect(Buffer.from(line.slice(19, -2), 'base64').toString('utf8')).toBe(
      'Wochenbudget erschöpft',
    );
  });

  // `buildMessage` being *able* to stamp a date is one claim; the mailer
  // handing its own clock down to it is another, and only the wire shows it.
  it('puts Date and Message-ID on the bytes that leave the socket', async () => {
    const fake = await start({ capabilities: [] });
    expect(await mailer(fake.port).send(MAIL)).toEqual({ ok: true });

    const headers = fake.payload.split('\n');
    expect(headers).toContain('Date: Sun, 02 Aug 2026 06:05:04 +0000');
    expect(headers.some((line) => /^Message-ID: <[^@>]+@example\.com>$/.test(line))).toBe(true);
  });

  it('authenticates with PLAIN over an already-secure channel', async () => {
    const fake = await start();
    const result = await mailer(
      fake.port,
      { secure: true, user: 'u', password: 'p' },
      alreadyPrivate,
    ).send(MAIL);
    expect(result).toEqual({ ok: true });
    const auth = fake.lines.find((line) => line.startsWith('AUTH')) ?? '';
    expect(auth).toBe(`AUTH PLAIN ${Buffer.from('\0u\0p').toString('base64')}`);
  });

  it('falls back to LOGIN when the server offers nothing else', async () => {
    const fake = await start({ capabilities: ['AUTH LOGIN'] });
    const result = await mailer(
      fake.port,
      { secure: true, user: 'u', password: 'p' },
      alreadyPrivate,
    ).send(MAIL);
    expect(result).toEqual({ ok: true });
    expect(fake.lines).toContain('AUTH LOGIN');
    expect(fake.lines).toContain(Buffer.from('u').toString('base64'));
    expect(fake.lines).toContain(Buffer.from('p').toString('base64'));
  });

  // The same rule, asked of the case the configuration flag used to wave
  // through: `secure: true` is a *claim* about the connection, and until this
  // was derived from the socket the claim was believed. That is the shape the
  // two cases above had — they configure `secure: true` over a plaintext
  // socket, and the assertion that the feature worked was an `AUTH PLAIN` line
  // carrying the password in base64 over cleartext.
  it('refuses when the configuration says secure and the socket is not', async () => {
    const fake = await start({ capabilities: ['AUTH PLAIN LOGIN'] });
    const result = await mailer(
      fake.port,
      { secure: true, user: 'u', password: 'geheim' },
      claimsPrivate,
    ).send(MAIL);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('kein STARTTLS');
    expect(fake.lines.some((line) => line.startsWith('AUTH'))).toBe(false);
    expect(fake.lines.some((line) => line.includes('geheim'))).toBe(false);
    expect(fake.lines.some((line) => line.includes(Buffer.from('geheim').toString('base64')))).toBe(
      false,
    );
  });

  // §19: a credential must never cross a socket nobody has encrypted. The
  // direction of this failure is deliberate — a refused mail is a log line.
  it('refuses to authenticate over a plaintext server that offers no STARTTLS', async () => {
    const fake = await start({ capabilities: ['AUTH PLAIN LOGIN'] });
    const result = await mailer(fake.port, { user: 'u', password: 'geheim' }).send(MAIL);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('kein STARTTLS');
    expect(fake.lines.some((line) => line.startsWith('AUTH'))).toBe(false);
    expect(fake.lines.some((line) => line.includes('geheim'))).toBe(false);
    expect(fake.lines.some((line) => line.includes(Buffer.from('geheim').toString('base64')))).toBe(
      false,
    );
  });

  it('issues STARTTLS and re-sends EHLO before authenticating', async () => {
    const fake = await start({ capabilities: ['STARTTLS', 'AUTH PLAIN'] });
    // Identity upgrade: the protocol is under test, the handshake is node:tls.
    // It reports `encrypted` because that is what `tlsConnect` returns here,
    // and it is what the client now reads before parting with a credential.
    const result = await mailer(
      fake.port,
      { user: 'u', password: 'p' },
      {
        connect: defaultSmtpTransport.connect,
        upgrade: async (socket) => Object.assign(socket, { encrypted: true }),
      },
    ).send(MAIL);

    expect(result).toEqual({ ok: true });
    const verbs = fake.lines.map((line) => line.split(' ')[0]);
    expect(verbs.slice(0, 4)).toEqual(['EHLO', 'STARTTLS', 'EHLO', 'AUTH']);
  });

  // What makes the *second* read load-bearing rather than decorative: without
  // it, an upgrade that did not take would be believed on the strength of
  // having been asked for. Unreachable through `defaultSmtpTransport`, which
  // returns a `TLSSocket` or throws — which is exactly why it is asserted here
  // and not left to the shape of the production transport.
  it('refuses when the upgrade hands back a socket that is not encrypted', async () => {
    const fake = await start({ capabilities: ['STARTTLS', 'AUTH PLAIN'] });
    const result = await mailer(
      fake.port,
      { user: 'u', password: 'geheim' },
      {
        connect: defaultSmtpTransport.connect,
        upgrade: async (socket) => socket,
      },
    ).send(MAIL);

    expect(result.ok).toBe(false);
    expect(fake.lines.map((line) => line.split(' ')[0]).slice(0, 3)).toEqual([
      'EHLO',
      'STARTTLS',
      'EHLO',
    ]);
    expect(fake.lines.some((line) => line.startsWith('AUTH'))).toBe(false);
    expect(fake.lines.some((line) => line.includes(Buffer.from('geheim').toString('base64')))).toBe(
      false,
    );
  });

  it('reports a refusing server without throwing, and names the code', async () => {
    const fake = await start({
      capabilities: [],
      reject: { verb: 'RCPT', code: 550, text: '5.1.1 No such user' },
    });
    const result = await mailer(fake.port).send(MAIL);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('550');
    expect(result.error).toContain('No such user');
  });

  // The mail is accepted at the 250 after DATA. A server that hangs up instead
  // of answering QUIT has still taken it — treating that as a failure would send
  // the same reminder again tomorrow.
  it('counts a mail as sent when the server hangs up on QUIT', async () => {
    const fake = await start({ capabilities: [], rudeQuit: true });
    expect(await mailer(fake.port).send(MAIL)).toEqual({ ok: true });
  });

  it('reports an unreachable server without throwing', async () => {
    const fake = await start({ capabilities: [] });
    const port = fake.port;
    fake.server.close();
    await once(fake.server, 'close');
    const result = await mailer(port).send(MAIL);
    expect(result.ok).toBe(false);
  });
});

describe('buildMessage', () => {
  const message = buildMessage('Vorschicht <v@example.org>', MAIL, { boundary: 'GRENZE' });

  it('terminates DATA with a lone dot on its own line', () => {
    expect(message.endsWith('\r\n.')).toBe(true);
  });

  it('separates the two alternatives with the boundary it declared', () => {
    expect(message).toContain('boundary="GRENZE"');
    expect(message.split('--GRENZE').length - 1).toBe(3); // two parts plus the closer
    expect(message).toContain('--GRENZE--');
  });

  it('uses CRLF throughout, which is the only line ending SMTP has', () => {
    expect(
      message
        .split('\n')
        .every((line, index, all) => index === all.length - 1 || line.endsWith('\r')),
    ).toBe(true);
  });

  // RFC 5322 §3.6: `Date` and `From` are the two fields a message may not omit.
  it('carries the two mandatory header fields', () => {
    const fields = message.split('\r\n').map((line) => line.split(':')[0]);
    expect(fields).toContain('Date');
    expect(fields).toContain('From');
  });

  it('stamps the date from the injected clock, in the form §4.3 asks for', () => {
    const stamped = buildMessage('Vorschicht <v@example.org>', MAIL, {
      boundary: 'GRENZE',
      now: () => Date.UTC(2026, 7, 2, 6, 5, 4),
    });
    expect(stamped).toContain('Date: Sun, 02 Aug 2026 06:05:04 +0000\r\n');
    // `toUTCString()`'s own suffix is the obsolete zone, and shipping it would
    // be the silent half of this — a header that parses and reads as ancient.
    expect(stamped).not.toContain('GMT');
  });

  it('gives every message its own id, on the sender’s domain', () => {
    const ids = [0, 1].map(
      () =>
        buildMessage('Vorschicht <v@example.org>', MAIL, { boundary: 'GRENZE' })
          .split('\r\n')
          .find((line) => line.startsWith('Message-ID: '))
          ?.slice('Message-ID: '.length) ?? '',
    );
    for (const id of ids) expect(id).toMatch(/^<[^@>]+@example\.org>$/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  // A malformed sender must not take the mail down with it: the id needs to be
  // unique, and it is the domain — not the address — that it borrows for that.
  it('falls back to a reserved domain when the sender has none to lend', () => {
    const odd = buildMessage('kaputt', MAIL, { boundary: 'GRENZE' });
    expect(odd).toMatch(/Message-ID: <[^@>]+@vorschicht\.invalid>/);
  });
});

describe('rfc5322Date', () => {
  it('writes the zone as an offset rather than as the obsolete name', () => {
    expect(rfc5322Date(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe('Thu, 01 Jan 2026 00:00:00 +0000');
    expect(rfc5322Date(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe('Thu, 31 Dec 2026 23:59:59 +0000');
  });
});

/**
 * The guard `buildMessage` cannot currently reach, tested where it can be.
 *
 * Base64 output contains no dot and no header begins with one, so nothing this
 * module produces exercises this today (see `dotStuff`). Asserting it through
 * `buildMessage` would therefore be a test that cannot fail — the shape §8.2's
 * third domain asks about — so it is asserted on the function itself, and the
 * unreachability is stated rather than papered over.
 */
describe('dotStuff', () => {
  it('doubles a leading dot and touches nothing else', () => {
    expect(dotStuff(['.punkt', 'ohne', '..zwei', 'mit.punkt'])).toEqual([
      '..punkt',
      'ohne',
      '...zwei',
      'mit.punkt',
    ]);
  });
});

describe('parseCapabilities', () => {
  // Without the four-character prefix coming off, `has('STARTTLS')` is false on
  // a server that offers it — and the client then sends a password in the clear.
  it('strips the status prefix and offers both the line and its verb', () => {
    const capabilities = parseCapabilities([
      '250-fake.local greets you',
      '250-STARTTLS',
      '250 AUTH PLAIN LOGIN',
    ]);
    expect(capabilities.has('STARTTLS')).toBe(true);
    expect(capabilities.has('AUTH PLAIN LOGIN')).toBe(true);
    expect(capabilities.has('AUTH')).toBe(true);
    expect(capabilities.has('250')).toBe(false);
  });

  it('reads no capability out of a single-line greeting', () => {
    expect(parseCapabilities(['250 fake.local greets you']).size).toBe(0);
  });
});

describe('addressOf', () => {
  it('strips the display name for the envelope', () => {
    expect(addressOf('Vorschicht <v@example.org>')).toBe('v@example.org');
    expect(addressOf('v@example.org')).toBe('v@example.org');
    expect(addressOf('  v@example.org ')).toBe('v@example.org');
  });
});

describe('encodeHeaderWord', () => {
  it('leaves ASCII alone and encodes anything else', () => {
    expect(encodeHeaderWord('Vorschicht: 2 items')).toBe('Vorschicht: 2 items');
    expect(encodeHeaderWord('Größe')).toBe('=?UTF-8?B?R3LDtsOfZQ==?=');
  });
});

describe('createMailer', () => {
  // `.env.example` ships SMTP blank; an installation without mail must boot.
  it('returns a disabled mailer that names the missing variable', async () => {
    const disabled = createMailer({ smtpFrom: 'v@example.org' });
    expect(disabled.enabled).toBe(false);
    const result = await disabled.send({ to: 'a@b', subject: 's', text: 't', html: '<p>t</p>' });
    expect(result).toEqual({
      ok: false,
      skipped: true,
      error: expect.stringContaining('SMTP_HOST'),
    });
  });

  it('is enabled as soon as host and sender are there — a relay needs no login', () => {
    expect(createMailer({ smtpHost: 'smtp.example', smtpFrom: 'v@example.org' }).enabled).toBe(
      true,
    );
  });

  it('never throws out of send, whatever the reason', async () => {
    const result = await new DisabledMailer('weil').send();
    expect(result.ok).toBe(false);
  });
});
