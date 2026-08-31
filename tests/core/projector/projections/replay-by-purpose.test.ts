import { describe, it, expect, beforeEach } from 'vitest';
import { ProjectionsStore } from '../../../src/core/projector/projections-store.js';
import { ReplayByPurposeProjection } from '../../../src/core/projector/projections/replay-by-purpose.js';
import type { StoredEventEnvelope } from '../../../src/core/event-bus/envelope.js';

function makeEvent(seq: number, family: string, subtype: string, handles: object = {}, payload: object = {}): StoredEventEnvelope {
  return { seq, timestamp: Date.now(), subject: { kind: 'agent', agentId: 'res-01' }, family: family as any, subtype, handles, payload, value: null } as StoredEventEnvelope;
}

describe('ReplayByPurposeProjection 按目的串事件链', () => {
  let projStore: ProjectionsStore;
  let proj: ReplayByPurposeProjection;

  beforeEach(() => {
    projStore = new ProjectionsStore(':memory:');
    proj = new ReplayByPurposeProjection();
    proj.initSchema(projStore);
  });

  it('有 purposeId 的事件写入事件链', () => {
    proj.applyEvent(projStore, makeEvent(1, 'task', 'created', { taskId: 'task-1', purposeId: 'purp-1' }));
    const chain = projStore.all('SELECT * FROM events_by_purpose WHERE purposeId = ? ORDER BY seq', 'purp-1') as any[];
    expect(chain).toHaveLength(1);
    expect(chain[0].seq).toBe(1);
  });

  it('无 purposeId 的事件不写入', () => {
    proj.applyEvent(projStore, makeEvent(1, 'task', 'created', { taskId: 'task-1' }));
    expect(projStore.all('SELECT * FROM events_by_purpose')).toHaveLength(0);
  });

  it('同一 purposeId 多条事件按 seq 排列', () => {
    proj.applyEvent(projStore, makeEvent(1, 'task', 'created', { taskId: 'task-1', purposeId: 'purp-1' }));
    proj.applyEvent(projStore, makeEvent(2, 'task', 'assigned', { taskId: 'task-1', purposeId: 'purp-1' }));
    proj.applyEvent(projStore, makeEvent(3, 'task', 'stateChanged', { taskId: 'task-1', purposeId: 'purp-1' }));
    const chain = projStore.all('SELECT * FROM events_by_purpose WHERE purposeId = ? ORDER BY seq', 'purp-1') as any[];
    expect(chain).toHaveLength(3);
    expect(chain[2].seq).toBe(3);
  });

  it('不同 purposeId 独立', () => {
    proj.applyEvent(projStore, makeEvent(1, 'task', 'created', { taskId: 'task-1', purposeId: 'purp-1' }));
    proj.applyEvent(projStore, makeEvent(2, 'task', 'created', { taskId: 'task-2', purposeId: 'purp-2' }));
    expect(projStore.all('SELECT * FROM events_by_purpose WHERE purposeId = ?', 'purp-1')).toHaveLength(1);
    expect(projStore.all('SELECT * FROM events_by_purpose WHERE purposeId = ?', 'purp-2')).toHaveLength(1);
  });
});
