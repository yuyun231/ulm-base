import { describe, it, expect, beforeEach } from 'vitest';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { ProjectionsStore } from '../../src/core/projector/projections-store.js';
import { TasksProjection } from '../../src/core/projector/projections/tasks.js';
import { AgentsProjection } from '../../src/core/projector/projections/agents.js';
import { ProjectionRunner } from '../../src/core/projector/runner.js';
import { LoadQueue } from '../../src/core/scheduler/load-queue.js';

function makeTaskEvent(seq: number, taskId: string, payload: object, agent: string = 'human-1'): any {
  return { seq: null, timestamp: Date.now(), subject: { kind: 'human', userId: agent }, family: 'task', subtype: 'created', handles: { taskId }, payload, value: null };
}

function setup() {
  const eventStore = new EventStore(':memory:');
  const bus = new EventBus(eventStore);
  const projStore = new ProjectionsStore(':memory:');
  const projections = [new TasksProjection(), new AgentsProjection()];
  const runner = new ProjectionRunner(bus, eventStore, projStore, projections);
  runner.start();
  const loadQueue = new LoadQueue();
  return { eventStore, bus, projStore, runner, loadQueue };
}

describe('LoadQueue focus过滤+排序', () => {
  it('无focus绑定时返回所有待加载任务', () => {
    const ctx = setup();
    ctx.bus.publish(makeTaskEvent(1, 't1', { taskType: 'normal', workspaceId: 'ws-1', priority: 1 } as any));
    ctx.bus.publish(makeTaskEvent(2, 't2', { taskType: 'normal', workspaceId: 'ws-1', priority: 5 } as any));
    const result = ctx.loadQueue.nextAssignment(ctx.projStore);
    expect(result).toBeDefined(); // 有任务可分配
    ctx.runner.stop();
    ctx.projStore.close();
    ctx.eventStore.close();
  });

  it('focus绑定时只返回该聚合任务的子任务', () => {
    const ctx = setup();
    // agent res-01 绑定 agg-1
    ctx.bus.publish({ seq: null, timestamp: Date.now(), subject: { kind: 'agent', agentId: 'res-01' }, family: 'schedule', subtype: 'woken', handles: {}, payload: {}, value: null });
    ctx.bus.publish({ seq: null, timestamp: Date.now(), subject: { kind: 'agent', agentId: 'res-01' }, family: 'schedule', subtype: 'focusBound', handles: {}, payload: { aggregateTaskId: 'agg-1' }, value: null });
    // t1 是 agg-1 的子任务
    ctx.bus.publish(makeTaskEvent(3, 't1', { taskType: 'normal', workspaceId: 'ws-1', parentTaskId: 'agg-1' } as any));
    // t2 是另一个聚合任务的子任务
    ctx.bus.publish(makeTaskEvent(4, 't2', { taskType: 'normal', workspaceId: 'ws-1', parentTaskId: 'agg-2' } as any));
    // 查询 res-01 的下一个分配——应只返回 t1
    const result = ctx.loadQueue.nextAssignmentForAgent(ctx.projStore, 'res-01');
    expect(result).toBeDefined();
    expect(result!.taskId).toBe('t1');
    ctx.runner.stop();
    ctx.projStore.close();
    ctx.eventStore.close();
  });

  it('按优先级降序+创建时间升序排列', () => {
    const ctx = setup();
    ctx.bus.publish(makeTaskEvent(1, 't1', { taskType: 'normal', workspaceId: 'ws-1', priority: 1 } as any));
    ctx.bus.publish(makeTaskEvent(2, 't2', { taskType: 'normal', workspaceId: 'ws-1', priority: 5 } as any));
    ctx.bus.publish(makeTaskEvent(3, 't3', { taskType: 'normal', workspaceId: 'ws-1', priority: 5 } as any));
    const list = ctx.loadQueue.getQueueForWorkspace(ctx.projStore, 'ws-1');
    // priority 5 在前，同优先级按创建时间升序
    expect(list[0].taskId).toBe('t2');
    expect(list[1].taskId).toBe('t3');
    expect(list[2].taskId).toBe('t1');
    ctx.runner.stop();
    ctx.projStore.close();
    ctx.eventStore.close();
  });
});
