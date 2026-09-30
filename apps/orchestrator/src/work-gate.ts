/**
 * The guardian's work gate (§7.2), and the adapter that keeps it from taking a
 * transition down with it.
 *
 * Until now `main()` handed `GuardianService` an object literal with a boolean
 * in it, above a comment saying "a `JobQueue` drops straight in here". The
 * queue it referred to — 298 lines, unit- and integration-tested against a real
 * Postgres since Phase 1 — was constructed nowhere in production, which is
 * A71's shape and §8.2's sixth domain in the one component §7 calls the most
 * safety-critical in the project.
 *
 * Five decisions.
 *
 *  1. **Nothing here throws, and that is the whole reason the class exists.**
 *     `GuardianService.applyTransition` awaits `queue.pause()` with no guard of
 *     its own, inside `evaluate()`, inside `Scheduler.tick()`. A `JobQueue`
 *     handed straight to the guardian raises `JobQueue ist nicht gestartet`
 *     whenever `start()` failed — so a database hiccup at boot would mean the
 *     guardian could never reach `wrap_up` at all, and the failure would
 *     surface as one "Tick fehlgeschlagen" line every fifteen seconds. That
 *     trades an unused queue for §1 principle 3.
 *
 *  2. **The decision is recorded even when the queue refused it.** `isPaused`
 *     answers what the guardian decided, never what pg-boss managed to do —
 *     the two are different facts and only the first is §7.2's, and a gate that
 *     reported "not paused" because pg-boss was unreachable would be the
 *     dangerous direction. What happened to the *queue* is reported through the
 *     log, through decision 4's single alert, and through what `start()`
 *     returns to its caller. Deliberately **not** through a `degraded` getter:
 *     the first draft had one and nothing read it, which is the dead wiring
 *     this commit exists to remove (A71, §8.2 domain 6) — inventing a consumer
 *     to justify an accessor is how that shape gets rebuilt.
 *
 *  3. **A failed `start()` is loud and not fatal.** Fatal would refuse to boot
 *     over a component that carries no work yet (A57.1: the dev chain is
 *     dispatched in-process, and no worker is registered until Phase 6) — a
 *     studio that will not start because of an idle queue is worse than one
 *     that starts and says the queue is down. Loud, because the alternative is
 *     Phase 6 discovering it.
 *
 *  4. **The alert fires on the transition, never per call.** A67.6 and A86.5,
 *     applied to a third caller: a push per guardian evaluation for as long as
 *     Postgres is unhappy is a channel that gets muted. At most one alert per
 *     outage; recovery is logged rather than pushed, because "the queue works
 *     again" is not news on a component nothing is waiting for yet.
 *
 *  5. **`stop()` is idempotent and swallows.** It runs from the shutdown path
 *     inside a `Promise.race` against a 20 s deadline (`main.ts`), where a
 *     rejection would skip the wrap-up park that the same block exists to do.
 */

/** Exactly what this module needs of `JobQueue`, so a test needs no Postgres. */
export interface PausableQueue {
  start(): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  readonly isPaused: boolean;
}

export interface WorkGateDeps {
  queue: PausableQueue;
  logger: {
    info(obj: unknown, message?: string): void;
    warn(obj: unknown, message?: string): void;
    error(obj: unknown, message?: string): void;
  };
  /** Only ever used for decision 4's transition alert. Optional: tests pass none. */
  notifier?: {
    send(message: {
      topic: 'inbox' | 'alerts' | 'info';
      title: string;
      message: string;
      priority?: 'min' | 'low' | 'default' | 'high' | 'urgent';
      tags?: string[];
    }): Promise<{ ok: boolean }>;
  };
}

export class WorkGate {
  /** What §7.2 decided. Never what pg-boss managed to do (decision 2). */
  private decision: 'open' | 'paused' = 'open';
  private started = false;
  /** The last German sentence the queue failed with, or null while it is fine. */
  private problem: string | null = null;
  /** Decision 4: true once the outage has been announced. */
  private announced = false;

  constructor(private readonly deps: WorkGateDeps) {}

  /**
   * Bring the queue up. Reports rather than throws (decision 3).
   *
   * pg-boss creates and migrates its own schema in here, so this is also the
   * only moment that arrangement is exercised before Phase 6 depends on it.
   */
  async start(): Promise<{ started: boolean; problem: string | null }> {
    try {
      await this.deps.queue.start();
      this.started = true;
      this.problem = null;
      this.deps.logger.info(
        {},
        'Job-Warteschlange bereit (§4) — sie ist das Tor, das der Wächter bei ≥ 85 % schließt (§7.2).',
      );
      return { started: true, problem: null };
    } catch (error) {
      this.problem = `Job-Warteschlange nicht gestartet: ${(error as Error).message}`;
      this.deps.logger.error(
        { err: error },
        `${this.problem} — der Wächter merkt sich seine Entscheidung trotzdem; ` +
          'die Sperre, die heute wirklich greift, ist die Wächterabfrage im Tick.',
      );
      await this.announce();
      return { started: false, problem: this.problem };
    }
  }

  /** §7.2: "no new tasks start". Records the decision whatever the queue does. */
  async pause(): Promise<void> {
    this.decision = 'paused';
    await this.apply(() => this.deps.queue.pause(), 'pausieren');
  }

  /** §7.2's reset path: parked work first, then the queue reopens. */
  async resume(): Promise<void> {
    this.decision = 'open';
    await this.apply(() => this.deps.queue.resume(), 'fortsetzen');
  }

  /** What §7.2 decided, not what pg-boss managed (decision 2). */
  get isPaused(): boolean {
    return this.decision === 'paused';
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    try {
      await this.deps.queue.stop();
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'Job-Warteschlange nicht sauber gestoppt');
    }
  }

  private async apply(call: () => Promise<void>, what: string): Promise<void> {
    if (!this.started) {
      // Nothing to relay. Already announced at start-up, and repeating it on
      // every guardian transition would be the flood decision 4 forbids.
      return;
    }
    try {
      await call();
      if (this.problem !== null) {
        this.problem = null;
        this.announced = false;
        this.deps.logger.info({}, 'Job-Warteschlange nimmt wieder Befehle an');
      }
    } catch (error) {
      this.problem = `Job-Warteschlange konnte nicht ${what}: ${(error as Error).message}`;
      this.deps.logger.error(
        { err: error, decision: this.decision },
        `${this.problem} — die Entscheidung des Wächters (${this.decision}) steht trotzdem.`,
      );
      await this.announce();
    }
  }

  /** Decision 4: once per outage, over the channel that is not this one. */
  private async announce(): Promise<void> {
    if (this.announced || !this.deps.notifier || !this.problem) return;
    const sent = await this.deps.notifier
      .send({
        topic: 'alerts',
        title: 'Vorschicht: Job-Warteschlange gestört',
        message:
          `${this.problem}\n\n` +
          'Der Wächter (§7.2) hält seine Entscheidung selbst fest und der Ablaufplaner fragt ihn ' +
          'vor jedem Tick — es startet also nichts, was nicht starten soll. Was fehlt, ist das ' +
          'zweite Tor für die geplante Arbeit ab Phase 6.',
        tags: ['warning'],
      })
      // An alert ntfy refused is an alert nobody got (`escalation-push.ts`
      // decision 2): leave it unannounced so the next failure tries again.
      .catch(() => ({ ok: false }));
    if (sent.ok) this.announced = true;
  }
}
