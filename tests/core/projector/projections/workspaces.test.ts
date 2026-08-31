import { describe, it, expect, beforeEach } from 'vitest';
import { ProjectionsStore } from '../../../src/core/projector/projections-store.js';
import { WorkspacesProjection } from '../../../src/core/projector/projections/workspaces.js';
import type { StoredEventEnvelope } from '../../../src/core/event-bus/envelope.js';

function makeTaskEvent(seq: number, subtype: string, handles: object = {}, payload: object = {}): StoredEventEnvelope {
  return { seq, timestamp: Date.now(), subject: { kind: 'agent', agentId: 'res-01' }, family: 'task', subtype, handles, payload, value: null } as StoredEventEnvelope;
}

describe('WorkspacesProjection 工作区投影', () => {
  let projStore: ProjectionsStore;
  let proj: WorkspacesProjection;

  beforeEach(() => {
    projStore = new ProjectionsStore(':memory:');
    proj = new WorkspacesProjection();
    proj.initSchema(projStore);
  });

  it('task.created 事件创建工作区记录', () => {
    proj.applyEvent(projStore, makeTaskEvent(1, 'created',
      { taskId: 'task-1', workspaceId: 'ws-1' },
      { taskType: 'normal', workspaceId: 'ws-1' } as any));
    const ws = projStore.get('SELECT * FROM workspaces WHERE workspaceId = ?', 'ws-1') as any;
    expect(ws).toBeDefined();
    expect(ws.workspaceId).toBe('ws-1');
  });

  it('无 workspaceId 的事件不创建记录', () => {
    proj.applyEvent(projStore, makeTaskEvent(1, 'created', { taskId: 'task-1' }, { taskType: 'normal' } as any));
    expect(projStore.all('SELECT * FROM workspaces')).toHaveLength(0);
  });

  it('重复 workspaceId 不重复插入', () => {
    proj.applyEvent(projStore, makeTaskEvent(1, 'created',
      { taskId: 'task-1', workspaceId: 'ws-1' }, { taskType: 'normal' } as any));
    proj.applyEvent(projStore, makeTaskEvent(2, 'created',
      { taskId: 'task-2', workspaceId: 'ws-1' }, { taskType: 'normal' } as any));
    expect(projStore.all('SELECT * FROM workspaces')).toHaveLength(1);
  });

  it('非任务族事件不处理', () => {
    proj.applyEvent(projStore, { ...makeTaskEvent(1, 'woken'), family: 'schedule' } as any);
    expect(projStore.all('SELECT * FROM workspaces')).toHaveLength(0);
  });
});
