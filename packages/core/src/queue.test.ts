import { describe, expect, it } from 'vitest';
import { JOB_NAMES, RETRY_POLICIES, singletonKey } from './queue.js';

describe('Job-Taxonomie', () => {
  it('hat für jede Jobart eine Retry-Politik', () => {
    for (const name of JOB_NAMES) {
      expect(RETRY_POLICIES[name], name).toBeDefined();
      expect(RETRY_POLICIES[name].expireInSeconds).toBeGreaterThan(0);
    }
  });

  // §9 owns the red path: first failure requeues with lower priority and a
  // learnings note, second escalates with a diagnosis. A queue-level retry
  // would silently burn a second model session and destroy the first
  // observation, which is the one carrying the information.
  it('wiederholt Agentenläufe nicht auf Queue-Ebene', () => {
    expect(RETRY_POLICIES.agent_run.retryLimit).toBe(0);
  });

  // A failed deploy must reach the rollback path (§12), not be retried into it.
  it('wiederholt Deploys nicht', () => {
    expect(RETRY_POLICIES.deploy.retryLimit).toBe(0);
  });

  // A25: infra failures retry three times with backoff and never count as red.
  it('gibt Gate-Läufen genau die drei Versuche aus A25, mit Backoff', () => {
    expect(RETRY_POLICIES.gate_run.retryLimit).toBe(3);
    expect(RETRY_POLICIES.gate_run.retryBackoff).toBe(true);
  });
});

describe('singletonKey', () => {
  // The crash window that matters: the orchestrator dies between "job sent"
  // and "job recorded". On restart it sends again — and must not produce a
  // second model session for the same run.
  it('macht Agentenläufe über die run_id eindeutig', () => {
    const key = singletonKey('agent_run', { runId: 'r1', taskId: 't1', role: 'coder' });
    expect(key).toBe('agent_run:r1');
    expect(singletonKey('agent_run', { runId: 'r1', taskId: null, role: 'planner' })).toBe(key);
  });

  it('unterscheidet verschiedene Läufe', () => {
    expect(singletonKey('agent_run', { runId: 'r1', taskId: null, role: 'coder' })).not.toBe(
      singletonKey('agent_run', { runId: 'r2', taskId: null, role: 'coder' }),
    );
  });

  it('bindet Merges an Projekt und Task', () => {
    expect(singletonKey('merge', { projectId: 'p', taskId: 't' })).toBe('merge:p:t');
  });

  it('macht den Wochenbericht je Woche eindeutig', () => {
    expect(singletonKey('report', { kind: 'weekly', forWeek: '2026-W31' })).toBe(
      'report:weekly:2026-W31',
    );
  });

  // Scans are periodic by nature — giving them an identity would mean the
  // second nightly radar run is silently dropped.
  it('lässt wiederholbare Jobs ohne Identität', () => {
    expect(singletonKey('scan', { kind: 'radar' })).toBeNull();
    expect(singletonKey('usage_sample', {})).toBeNull();
  });
});
