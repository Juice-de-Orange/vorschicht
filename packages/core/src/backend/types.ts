/**
 * The `ModelBackend` contract (§6.0).
 *
 * §6.0 calls this abstraction "the project's survival layer", and the reason is
 * concrete rather than architectural taste: Anthropic announced and then paused
 * a billing change that would have moved `claude -p` off subscription limits.
 * If that returns, Vorschicht has to be able to swap how it reaches a model
 * without rewriting everything that uses one.
 *
 * That imposes one hard rule, and this file exists to hold the line on it:
 * **nothing outside a backend ever sees vendor-shaped data.** Callers consume
 * `BackendEvent`s. The moment a caller pattern-matches on Claude Code's own
 * stream-json message types, the `interactive-pty` and `api-key` backends of
 * A31 become unimplementable and the abstraction is decoration.
 */
import type {
  BackendCapabilities,
  BackendEvent,
  GetUsageResponse,
  ResumeSpec,
  SessionSpec,
} from '@vorschicht/shared';

export type BackendName = 'headless' | 'fake' | 'interactive-pty' | 'api-key';

/** Why a caller asked a run to stop. Distinct from why it *did* stop. */
export type StopReason = 'guardian_wrap_up' | 'guardian_hard_stop' | 'operator' | 'cap_exceeded';

export interface RunHandle {
  readonly runId: string;
  /** The session id — assigned by us before spawning, never parsed out after. */
  readonly sessionId: string;
  readonly cwd: string;

  /** Domain events, in order, ending with exactly one `terminated`. */
  events(): AsyncIterable<BackendEvent>;

  /**
   * Current official usage, or null when this backend cannot ask.
   * Callers must check `capabilities().supportsUsageQuery` first.
   */
  queryUsage(): Promise<GetUsageResponse | null>;

  /**
   * Where this backend left its own session log, or null if it keeps none.
   *
   * §6.2 requires a copy of the session transcript in the transcripts volume,
   * and §18 keeps it for a year — principle 4's traceability chain ends at the
   * transcript line where a decision was made. *Where* a backend writes that
   * log is vendor knowledge and therefore belongs behind this interface: the
   * headless backend derives it from the CLI's own layout, an `api-key` backend
   * would have to write one itself, and a backend with no transcript at all
   * says so rather than being asked to fake one.
   *
   * Only meaningful once the run has terminated; before that the file exists
   * but is still being written.
   */
  transcriptPath(): Promise<string | null>;

  /**
   * Ask the run to stop gracefully.
   *
   * §7.3 step 1 — "finish the current atomic step, never mid-edit" — is only
   * achievable this way. A timeout kill is by definition not graceful, which
   * is why A32 makes the backend-side cap the one that stops a run properly
   * and the process kill the last resort behind it.
   */
  interrupt(reason: StopReason): Promise<void>;

  /** Last resort: terminate the process group. Never graceful. */
  kill(): Promise<void>;
}

export interface ModelBackend {
  readonly name: BackendName;
  capabilities(): BackendCapabilities;
  spawn(spec: SessionSpec): Promise<RunHandle>;
  /**
   * Continue an existing session (§6.4, §6.2).
   *
   * Resume is scoped to the directory the session started in — that is CLI
   * behaviour, not our choice — so `cwd` is part of the spec rather than
   * remembered. So are the role settings and the run environment: a resumed
   * session writes, and a session that writes without §6.6's hooks is not
   * contained (see `ResumeSpec`).
   */
  resume(spec: ResumeSpec): Promise<RunHandle>;
}

/**
 * Thrown by backends that exist as typed slots rather than implementations
 * (A31). Failing loudly and specifically is the point: a stub that returned
 * empty results would let a caller believe it had a model.
 */
export class BackendNotImplementedError extends Error {
  constructor(
    readonly backend: BackendName,
    readonly reason: string,
  ) {
    super(
      `Backend "${backend}" ist nicht implementiert. ${reason} ` +
        'Aktivierung erfordert eine ausdrückliche Entscheidung des Betreibers (§6.0, A31).',
    );
    this.name = 'BackendNotImplementedError';
  }
}

/** Backends that must never be reachable without an explicit decision (§6.0). */
export const CONTINGENCY_BACKENDS: Record<
  Extract<BackendName, 'interactive-pty' | 'api-key'>,
  string
> = {
  'interactive-pty':
    'Es automatisiert die interaktive Oberfläche und ist damit ToS-grau sowie technisch spröde; ' +
    'vor einer Umsetzung braucht es eine frische Rechts- und Machbarkeitsprüfung.',
  'api-key': 'Es kostet Geld und ist durch §2 ausdrücklich verboten.',
};

export type { BackendCapabilities, BackendEvent, ResumeSpec, SessionSpec };
