/**
 * §17.8's Controlling page over HTTP: the budget as it stands, and the operator's two
 * switches.
 *
 * `@vorschicht/shared/controlling` owns what the switch positions mean and how
 * a number has to be labelled; `ControllingSettings` owns persistence and §19's
 * trail; `evaluateGuardian` owns §7.2. Nothing here re-decides any of them.
 * What this module adds is the translation a transport needs — and one thing
 * that is genuinely its own, decision 4.
 *
 *  1. **A refusal is a value, never an exception** — `einstellungen.ts`,
 *     `quellen.ts` and `dokumente.ts`'s posture, and load-bearing rather than
 *     tidy: there is no `app.onError` anywhere in this app, so a throw becomes a
 *     plain-text 500 with an English stack behind it, on a page whose every
 *     other string is German (§2).
 *
 *  2. **The actor is the session, never a default.** `ControllingSettings`
 *     takes it as a required argument for A75.3's reason. Sharper here than
 *     anywhere else this rule has been applied: the trail row for a pause is the
 *     only record of *why the studio stopped working*, and one that says
 *     `system` turns a deliberate act by the operator into an unexplained outage.
 *
 *  3. **Both writes answer the whole payload**, not an acknowledgement
 *     (`einstellungen.ts` decision 3's reasoning). The guardian's state is a
 *     *consequence* of the pause, so a page redrawing from what it hoped it had
 *     sent could show "Pause" above a guardian line still reading Normalbetrieb
 *     — and a reader would not know which of the two to believe. The reply
 *     carries the recomputed guardian line, so the page shows one story.
 *
 *  4. **The tier table is computed here from `resolveTier`, and that is the
 *     point of it.** §8.2 rule 3 exempts *the auditor* from A22's downgrade and
 *     A22 switches *idle audits* off — two different rules one sentence apart,
 *     and a hand-written list is exactly where they get merged. Asking the real
 *     function for every profile means the page shows what the studio would
 *     actually do, so an auditor that ever started downgrading would appear on
 *     the page rather than in an audit two phases later.
 *
 *  5. **The history query is bounded in the database, not in the page.**
 *     `usage_samples` grows by a row per window per reading forever (§18), so an
 *     unbounded select would be a page that gets slower every day and eventually
 *     stops loading — on the one page whose job is to say whether the studio can
 *     still work.
 */
import {
  AGENT_PROFILES,
  type ControllingSettings,
  type Gelesen,
  resolveTier,
} from '@vorschicht/core';
import {
  CONCURRENCY_RANGE,
  DEGRADED_WRAP_UP_PERCENT,
  describeGuardian,
  type GuardianDecision,
  type GuardianReason,
  type GuardianState,
  type UsageSample,
  type WindowLatch,
} from '@vorschicht/shared';
import {
  budgetVertrauen,
  CONTROLLING_API,
  type ControllingBody,
  type FensterView,
  GUARDIAN_THRESHOLDS,
  type PauseMode,
  parsePauseSubmission,
  parseSparbetriebSubmission,
  SPARBETRIEB_WIRKUNGEN,
  type StufenZeile,
  type VerlaufPunkt,
} from '@vorschicht/shared/controlling';
import type postgres from 'postgres';

/** How far back the graphs look. A day of readings, and no more (decision 5). */
export const VERLAUF_FENSTER_MS = 24 * 60 * 60_000;

/** Hard ceiling on points, so one busy day cannot make the page unloadable. */
export const VERLAUF_MAX_PUNKTE = 500;

/**
 * Exactly the calls this module makes (`SmokeRunner`'s posture, A57.6).
 *
 * Structural rather than the class, so a fake has to match the real signatures
 * — which is the drift a test of this layer exists to catch.
 */
export interface ControllingSettingsPort {
  pause(): Promise<Gelesen<PauseMode>>;
  setPause(mode: PauseMode, actor: string): Promise<{ before: PauseMode; after: PauseMode }>;
  sparbetrieb(): Promise<Gelesen<boolean>>;
  setSparbetrieb(aktiv: boolean, actor: string): Promise<{ before: boolean; after: boolean }>;
}

export interface ControllingDeps {
  sql: postgres.Sql;
  settings: ControllingSettingsPort;
  /** §7.1's current per-window reading, as the overview already reads it. */
  currentSamples: () => Promise<UsageSample[]>;
  /**
   * A7/A8 as the daemon actually runs them.
   *
   * Passed in rather than derived here, because the number that matters is the
   * one the *scheduler* was constructed with — and this process is not that
   * process. A value computed here from the plan profile would agree with the
   * daemon right up until somebody changes one of the two.
   */
  betrieb: { planProfile: string; concurrency: number };
}

/** Three outcomes, three status codes — `einstellungen.ts`'s table. */
export type ControllingResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'invalid'; errors: string[] }
  | { ok: false; reason: 'failed'; errors: string[] };

export const CONTROLLING_STATUS = { invalid: 422, failed: 500 } as const;

/** The whole page in one request (§17.8, and §17.1's reasoning about round trips). */
export async function getControlling(
  deps: ControllingDeps,
): Promise<ControllingResult<ControllingBody>> {
  try {
    return { ok: true, value: await buildControlling(deps) };
  } catch (cause) {
    return failed(cause);
  }
}

/** Move A26's switch (§7.2), audited (§19). */
export async function setPauseMode(
  deps: ControllingDeps,
  body: unknown,
  actor: string,
): Promise<ControllingResult<ControllingBody>> {
  const parsed = parsePauseSubmission(body);
  if (!parsed.ok) return { ok: false, reason: 'invalid', errors: parsed.errors };
  try {
    await deps.settings.setPause(parsed.value.modus, actor);
    return { ok: true, value: await buildControlling(deps) };
  } catch (cause) {
    return failed(cause);
  }
}

/** Move A22's switch (§6.0), audited (§19). */
export async function setSparbetrieb(
  deps: ControllingDeps,
  body: unknown,
  actor: string,
): Promise<ControllingResult<ControllingBody>> {
  const parsed = parseSparbetriebSubmission(body);
  if (!parsed.ok) return { ok: false, reason: 'invalid', errors: parsed.errors };
  try {
    await deps.settings.setSparbetrieb(parsed.value.aktiv, actor);
    return { ok: true, value: await buildControlling(deps) };
  } catch (cause) {
    return failed(cause);
  }
}

async function buildControlling(deps: ControllingDeps): Promise<ControllingBody> {
  const [guardianRow] = await deps.sql<
    Array<{
      state: GuardianState;
      reason: GuardianReason;
      governing_window: string | null;
      latches: WindowLatch[];
      occurred_at: Date;
    }>
  >`
    SELECT state, reason, governing_window, latches, occurred_at
    FROM guardian_events ORDER BY id DESC LIMIT 1
  `;

  const decision: GuardianDecision = {
    // No recorded state yet means nothing has evaluated the budget — which is
    // the "cannot see it" case, not a calm one (`overview.ts`'s reasoning).
    state: guardianRow?.state ?? 'wrap_up',
    reason: guardianRow?.reason ?? { kind: 'no_data' },
    latches: guardianRow?.latches ?? [],
    governingWindow: (guardianRow?.governing_window as GuardianDecision['governingWindow']) ?? null,
  };

  const samples = await deps.currentSamples();
  const [pause, sparbetrieb] = await Promise.all([
    deps.settings.pause(),
    deps.settings.sparbetrieb(),
  ]);

  return {
    controlling: {
      waechter: {
        state: decision.state,
        text: describeGuardian(decision),
        governingWindow: decision.governingWindow,
        since: guardianRow?.occurred_at?.toISOString() ?? null,
      },
      schwellen: {
        wrapUpPercent: GUARDIAN_THRESHOLDS.WRAP_UP_PERCENT,
        hardStopPercent: GUARDIAN_THRESHOLDS.HARD_STOP_PERCENT,
        // A73/A64: the estimate is thresholded lower, and the page has to be
        // able to draw that line or the earlier stop looks like a malfunction.
        degradedWrapUpPercent: DEGRADED_WRAP_UP_PERCENT,
      },
      fenster: samples.map(fensterView),
      verlauf: await readVerlauf(deps.sql),
      pause: { modus: pause.wert, unlesbar: pause.unlesbar },
      sparbetrieb: {
        aktiv: sparbetrieb.wert,
        unlesbar: sparbetrieb.unlesbar,
        wirkungen: SPARBETRIEB_WIRKUNGEN.map((wirkung) => ({
          id: wirkung.id,
          text: wirkung.text,
          wirksam: wirkung.wirksam,
          verdrahtung: wirkung.verdrahtung,
          // `null` rather than absent: the schema is the contract and an
          // optional key would let a producer omit it by accident, which is
          // how "no reason given" and "no reason needed" stop being distinct.
          offen: wirkung.offen ?? null,
        })),
        stufen: sparbetriebStufen(),
      },
      betrieb: {
        planProfile: deps.betrieb.planProfile,
        concurrency: deps.betrieb.concurrency,
        concurrencyRange: { min: CONCURRENCY_RANGE.min, max: CONCURRENCY_RANGE.max },
      },
    },
  };
}

/**
 * One window, with the sentence that says what its number is worth.
 *
 * `vertrauen` is attached here rather than on the page so that one
 * implementation of A73's rule feeds both this and §16's report later — and the
 * page's own test asserts the server's answer *equals* `budgetVertrauen`, so
 * the string is checked against the rule rather than trusted.
 */
export function fensterView(sample: UsageSample): FensterView {
  const anomaly = sample.anomaly?.kind ?? null;
  return {
    window: sample.window,
    modelClass: sample.modelClass,
    usedPercent: sample.usedPercent,
    resetsAt: sample.resetsAt,
    source: sample.source,
    anomaly,
    vertrauen: budgetVertrauen({
      usedPercent: sample.usedPercent,
      source: sample.source,
      anomaly,
    }),
  };
}

/**
 * A22's ceiling applied to every profile, by the real function (decision 4).
 *
 * Exported so it can be asserted without a database: the two exemptions this
 * table exists to make visible — the Reviewer's (A22) and the auditor's (§8.2
 * rule 3) — are rules in `resolveTier`, and a test that re-stated them here
 * would be checking a copy.
 */
export function sparbetriebStufen(): StufenZeile[] {
  return Object.values(AGENT_PROFILES).map((profile) => ({
    profileId: profile.id,
    department: profile.department,
    normal: resolveTier(profile),
    sparbetrieb: resolveTier(profile, { sparbetrieb: true }),
  }));
}

/**
 * The readings behind the graphs (decision 5).
 *
 * Ordered oldest-first because that is the order a line is drawn in, and doing
 * it in SQL keeps the page from holding an opinion about time. The window and
 * the cap are both applied: a day is the useful range, and the cap is what
 * stops a pathological day from being unbounded.
 */
async function readVerlauf(sql: postgres.Sql): Promise<VerlaufPunkt[]> {
  const rows = await sql<
    Array<{
      window_kind: VerlaufPunkt['window'];
      model_class: string | null;
      used_percent: string | number;
      source: VerlaufPunkt['source'];
      observed_at: Date;
    }>
  >`
    SELECT window_kind, model_class, used_percent, source, observed_at
    FROM (
      SELECT window_kind, model_class, used_percent, source, observed_at
      FROM usage_samples
      WHERE observed_at > now() - ${`${VERLAUF_FENSTER_MS} milliseconds`}::interval
      ORDER BY observed_at DESC
      LIMIT ${VERLAUF_MAX_PUNKTE}
    ) neueste
    ORDER BY observed_at ASC
  `;
  return rows.map((row) => ({
    window: row.window_kind,
    modelClass: row.model_class,
    // `numeric` arrives as a string from postgres; a page that plotted it would
    // silently sort and scale by string order.
    usedPercent: Number(row.used_percent),
    source: row.source,
    observedAt: row.observed_at.getTime(),
  }));
}

function failed(cause: unknown): ControllingResult<never> {
  // The message rather than the stack: this reaches a page (§2).
  const detail = cause instanceof Error ? cause.message : String(cause);
  return {
    ok: false,
    reason: 'failed',
    errors: [`Controlling konnte nicht geladen oder gespeichert werden: ${detail}`],
  };
}

export type { ControllingSettings };
/** Re-exported so a caller assembling the routes uses the same paths (A81.3). */
export { CONTROLLING_API };
