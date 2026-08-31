import { describe, it, expect, beforeEach } from 'vitest';
import { ProjectionsStore } from '../../../src/core/projector/projections-store.js';
import { TasksProjection } from '../../../src/core/projector/projections/tasks.js';
import type { StoredEventEnvelope } from '../../../src/core/event-bus/envelope.js';

function makeEvent(seq: number, subtype: string, handles: object = {}, payload: object = {}): StoredEventEnvelope {
  return { seq, timestamp: Date.now(), subject: { kind: 'agent', agentId: 'res-01' }, family: 'task', subtype, handles, payload, value: null } as StoredEventEnvelope;
}

describe('TasksProjection 任务投影', () => {
  let projStore: ProjectionsStore;
  let proj: TasksProjection;

  beforeEach(() => {
    projStore = new ProjectionsStore(':memory:');
    proj = new TasksProjection();
    proj.initSchema(projStore);
  });

  it('created 事件创建任务记录', () => {
    proj.applyEvent(projStore, makeEvent(1, 'created', { taskId: 'task-1' }, {
      taskType: 'normal', goal: '测试任务', acceptanceCriteria: '通过测试',
      priority: 5, workspaceId: 'ws-1', createdBy: 'human-1',
    } as any));
    const tasks = projStore.all('SELECT * FROM tasks') as any[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskId).toBe('task-1');
    expect(tasks[0].state).toBe('pending'); // 待办
  });

  it('assigned 事件改状态为进行', () => {
    proj.applyEvent(projStore, makeEvent(1, 'created', { taskId: 'task-1' }, { taskType: 'normal', workspaceId: 'ws-1' } as any));
    proj.applyEvent(projStore, makeEvent(2, 'assigned', { taskId: 'task-1' }, { agentId: 'res-01' }));
    const task = projStore.get('SELECT * FROM tasks WHERE taskId = ?', 'task-1') as any;
    expect(task.state).toBe('inProgress');
    expect(task.assignedAgent).toBe('res-01');
  });

  it('stateChanged 事件改任务状态', () => {
    proj.applyEvent(projStore, makeEvent(1, 'created', { taskId: 'task-1' }, { taskType: 'normal' } as any));
    proj.applyEvent(projStore, makeEvent(2, 'stateChanged', { taskId: 'task-1' }, { newState: 'paused' }));
    const task = projStore.get('SELECT * FROM tasks WHERE taskId = ?', 'task-1') as any;
    expect(task.state).toBe('paused');
  });

  it('非任务族事件不处理', () => {
    proj.applyEvent(projStore, { ...makeEvent(1, 'woken'), family: 'schedule' } as any);
    expect(projStore.all('SELECT * FROM tasks')).toHaveLength(0);
  });
});
