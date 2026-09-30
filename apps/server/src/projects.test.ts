/**
 * §12's release history on the way to the page — the mapping, without a database.
 *
 * `projects.itest.ts` proves that the rows reach this function; what is proved
 * here is the one piece of judgement in it. `rolled_back_to` is a deployment
 * *id*, and an id answers none of the questions somebody opens the release table
 * with. It is resolved against the window being sent, and where that cannot be
 * done the row says so instead of showing an id as though it were a sha.
 */
import type { DeploymentRecord } from '@vorschicht/core';
import { describe, expect, it } from 'vitest';
import { toReleaseHistory } from './projects.js';

function record(over: Partial<DeploymentRecord> & { id: string }): DeploymentRecord {
  return {
    projectId: 'p-1',
    taskId: 't-1',
    sha: `sha-${over.id}`,
    method: 'compose',
    artifact: `image:${over.id}`,
    startedAt: new Date('2026-08-02T10:00:00.000Z'),
    lastStep: 'succeeded',
    healthOk: true,
    healthDetail: 'HTTP 200',
    outcome: 'succeeded',
    finishedAt: new Date('2026-08-02T10:01:00.000Z'),
    rolledBackTo: null,
    problem: null,
    durationMs: 60_000,
    ...over,
  };
}

describe('toReleaseHistory', () => {
  it('überträgt einen Rollout mit allem, was §12 auf der Seite verlangt', () => {
    const [view] = toReleaseHistory([record({ id: 'd-1' })]);
    expect(view).toEqual({
      id: 'd-1',
      sha: 'sha-d-1',
      method: 'compose',
      artifact: 'image:d-1',
      outcome: 'succeeded',
      lastStep: 'succeeded',
      startedAt: '2026-08-02T10:00:00.000Z',
      finishedAt: '2026-08-02T10:01:00.000Z',
      durationMs: 60_000,
      problem: null,
      rolledBackTo: null,
      taskId: 't-1',
    });
  });

  it('löst das Rollback-Ziel gegen dasselbe Fenster auf', () => {
    const history = toReleaseHistory([
      record({
        id: 'd-2',
        outcome: 'rolled_back',
        rolledBackTo: 'd-1',
        problem: 'HTTP 500',
        lastStep: 'rolled_back',
      }),
      record({ id: 'd-1' }),
    ]);

    // The sha and the artifact both, and both from the row they belong to: after
    // a prune the sha is history and the artifact is what is on the disk, and a
    // rollback destination is only useful if it names the second.
    expect(history[0]?.rolledBackTo).toEqual({
      deploymentId: 'd-1',
      sha: 'sha-d-1',
      artifact: 'image:d-1',
    });
  });

  it('gibt zu, wenn das Ziel außerhalb des Fensters liegt, statt eine Id auszugeben', () => {
    const [view] = toReleaseHistory([
      record({ id: 'd-2', outcome: 'rolled_back', rolledBackTo: 'd-0' }),
    ]);
    // Nulls rather than a guess: the page renders "ein älteres Release" from
    // exactly this, and a fabricated sha would be worse than the id.
    expect(view?.rolledBackTo).toEqual({ deploymentId: 'd-0', sha: null, artifact: null });
  });

  it('lässt die Reihenfolge, wie sie kommt — neueste zuerst', () => {
    const history = toReleaseHistory([record({ id: 'd-3' }), record({ id: 'd-2' })]);
    expect(history.map((view) => view.id)).toEqual(['d-3', 'd-2']);
  });

  it('überträgt einen abgebrochenen Rollout ohne Ergebnis', () => {
    // The record of a deploy the orchestrator died inside. `lastStep` is the
    // only thing that says whether anything was swapped, so it has to travel.
    const [view] = toReleaseHistory([
      record({ id: 'd-4', outcome: null, finishedAt: null, durationMs: null, lastStep: 'swapped' }),
    ]);
    expect(view).toMatchObject({ outcome: null, finishedAt: null, durationMs: null });
    expect(view?.lastStep).toBe('swapped');
  });
});
