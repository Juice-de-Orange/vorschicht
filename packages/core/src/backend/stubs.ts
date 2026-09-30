/**
 * Contingency backends as prepared slots (A31, §6.0).
 *
 * These are not placeholders in the usual sense. §6.0's playbook is that if
 * Anthropic's paused billing change returns, Vorschicht implements its own
 * fallback backend *as its first emergency task inside the announced notice
 * window*. That only works if the shape is already decided — which is what
 * these stubs, and their presence in the shared contract suite, guarantee.
 *
 * They fail loudly and specifically. A stub that returned empty results would
 * let a caller believe it had reached a model, which is the one failure mode
 * worse than not having a backend at all.
 */
import type { BackendCapabilities, ResumeSpec, SessionSpec } from '@vorschicht/shared';
import {
  type BackendName,
  BackendNotImplementedError,
  CONTINGENCY_BACKENDS,
  type ModelBackend,
  type RunHandle,
} from './types.js';

/**
 * Drives the interactive REPL in a pseudo-terminal (tmux), because Anthropic's
 * paused plan explicitly left *interactive* terminal use on the subscription.
 *
 * Honest assessment, unchanged from §6.0: this is ToS-grey — it automates a
 * surface meant for a human — and technically brittle, since it screen-scrapes.
 * A design note lives in docs/; implementing it needs an explicit decision from
 * the operator plus a fresh legality and viability assessment at that time.
 */
export class InteractivePtyBackend implements ModelBackend {
  readonly name: BackendName = 'interactive-pty';

  capabilities(): BackendCapabilities {
    // Deliberately truthful about the design rather than optimistic: a PTY
    // gives no structured output and no control channel, so callers that
    // branch on capabilities will already do the right thing on the day this
    // becomes real.
    return {
      supportsResume: true,
      supportsStructuredOutput: false,
      supportsUsageQuery: false,
      supportsInterrupt: true,
    };
  }

  async spawn(_spec: SessionSpec): Promise<RunHandle> {
    throw new BackendNotImplementedError(this.name, CONTINGENCY_BACKENDS['interactive-pty']);
  }

  async resume(_spec: ResumeSpec): Promise<RunHandle> {
    throw new BackendNotImplementedError(this.name, CONTINGENCY_BACKENDS['interactive-pty']);
  }
}

/**
 * Direct API access. Clean and reliable, and forbidden: §2 makes "no API key,
 * ever" a hard rule, and activating this would require the operator personally revising
 * that rule through an inbox decision — plus a guardian-enforced spend cap.
 */
export class ApiKeyBackend implements ModelBackend {
  readonly name: BackendName = 'api-key';

  capabilities(): BackendCapabilities {
    return {
      supportsResume: false,
      supportsStructuredOutput: true,
      supportsUsageQuery: false,
      supportsInterrupt: true,
    };
  }

  async spawn(_spec: SessionSpec): Promise<RunHandle> {
    throw new BackendNotImplementedError(this.name, CONTINGENCY_BACKENDS['api-key']);
  }

  async resume(_spec: ResumeSpec): Promise<RunHandle> {
    throw new BackendNotImplementedError(this.name, CONTINGENCY_BACKENDS['api-key']);
  }
}
