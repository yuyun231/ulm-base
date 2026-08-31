import { describe, it, expect, beforeEach } from 'vitest';
import { ProjectionsStore } from '../../../src/core/projector/projections-store.js';
import { LoadQueueProjection } from '../../../src/core/projector/projections/load-queue.js';
import type { StoredEventEnvelope } from '../../../src/core/event-bus/envelope.js';

function makeTaskEvent(seq: number, subtype: string, handles: object = {}, payload: object = {}): StoredEventEnvelope {
  return { seq, timestamp: Date.now(), subject: { kind: 'agent', agentId: 'res-01' }, family: 'task', subtype, handles, payload, value: null } as StoredEventEnvelope;
}

describe('LoadQueueProjection 加载队列投影', () => {
  let projStore: ProjectionsStore;
  let proj: LoadQueueProjection;

  beforeEach(() => {
    projStore = new ProjectionsStore(':memory:');
    proj = new LoadQueueProjection();
    proj.initSchema(projStore);
  });

  it('created 事件入队（pending 且无 assignedAgent）', () => {
    proj.applyEvent(projStore, makeTaskEvent(1, 'created', { taskId: 'task-1' }, { taskType: 'normal' } as any));
    const queue = projStore.all('SELECT * FROM load_queue') as any[];
    expect(queue).toHaveLength(1);
    expect(queue[0].taskId).toBe('task-1');
    expect(queue[0].state).toBe('pending');
  });

  it('assigned 事件出队（从队列删除）', () => {
    proj.applyEvent(projStore, makeTaskEvent(1, 'created', { taskId: 'task-1' }, { taskType: 'normal' } as any));
    proj.applyEvent(projStore, makeTaskEvent(2, 'assigned', { taskId: 'task-1' }, { agentId: 'res-01' }));
    const queue = projStore.all('SELECT * FROM load_queue') as any[];
    expect(queue).toHaveLength(0);
  });

  it('澄清6：完整视图不过滤——stateChanged 到 paused 仍在队列', () => {
    proj.applyEvent(projStore, makeTaskEvent(1, 'created', { taskId: 'task-1' }, { taskType: 'normal' } as any));
    proj.applyEvent(projStore, makeTaskEvent(2, 'stateChanged', { taskId: 'task-1' }, { newState: 'paused' }));
    const queue = projStore.all('SELECT * FROM load_queue') as any[];
    expect(queue).toHaveLength(1);
    expect(queue[0].state).toBe('paused');
  });

  it('非任务族事件不处理', () => {
    proj.applyEvent(projStore, { ...makeTaskEvent(1, 'woken'), family: 'schedule' } as any);
    expect(projStore.all('SELECT * FROM load_queue')).toHaveLength(0);
  });
});
