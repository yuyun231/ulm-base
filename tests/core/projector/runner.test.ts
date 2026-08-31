import { describe, it, expect } from 'vitest';
import { ProjectionRunner } from '../../src/core/projector/runner.js';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { ProjectionsStore } from '../../src/core/projector/projections-store.js';
import type { StoredEventEnvelope } from '../../src/core/event-bus/envelope.js';

// 测试用投影：记录所有收到的事件子类型
function makeSpyProjection() {
  const received: string[] = [];
  return {
    initSchema: () => { received.length = 0; },
    applyEvent: (_db: any, env: StoredEventEnvelope) => { received.push(env.subtype); },
    getReceived: () => received,
  };
}

describe('ProjectionRunner 投影器', () => {
  it('订阅事件总线，收到事件分发给投影', () => {
    const eventStore = new EventStore(':memory:');
    const bus = new EventBus(eventStore);
    const projStore = new ProjectionsStore(':memory:');
    const spy = makeSpyProjection();
    const runner = new ProjectionRunner(bus, eventStore, projStore, [spy as any]);
    runner.start();
    bus.publish({ seq: null, timestamp: Date.now(), subject: { kind: 'agent', agentId: 'a' }, family: 'task', subtype: 'created', handles: {}, payload: {}, value: null });
    bus.publish({ seq: null, timestamp: Date.now(), subject: { kind: 'agent', agentId: 'a' }, family: 'task', subtype: 'assigned', handles: {}, payload: {}, value: null });
    expect(spy.getReceived()).toEqual(['created', 'assigned']);
    runner.stop();
    projStore.close();
    eventStore.close();
  });

  it('replayAll 从事件库全量重放重建投影', () => {
    const eventStore = new EventStore(':memory:');
    const bus = new EventBus(eventStore);
    const projStore = new ProjectionsStore(':memory:');
    const spy = makeSpyProjection();
    // 先发3条事件（runner 未启动，投影未消费）
    bus.publish({ seq: null, timestamp: Date.now(), subject: { kind: 'agent', agentId: 'a' }, family: 'task', subtype: 'created', handles: {}, payload: {}, value: null });
    bus.publish({ seq: null, timestamp: Date.now(), subject: { kind: 'agent', agentId: 'a' }, family: 'task', subtype: 'assigned', handles: {}, payload: {}, value: null });
    bus.publish({ seq: null, timestamp: Date.now(), subject: { kind: 'agent', agentId: 'a' }, family: 'task', subtype: 'stateChanged', handles: {}, payload: {}, value: null });
    expect(spy.getReceived()).toEqual([]); // 未消费
    // replayAll 全量重放
    const runner = new ProjectionRunner(bus, eventStore, projStore, [spy as any]);
    runner.replayAll();
    expect(spy.getReceived()).toEqual(['created', 'assigned', 'stateChanged']);
    runner.stop();
    projStore.close();
    eventStore.close();
  });

  it('replayAll 先清空再重放（幂等）', () => {
    const eventStore = new EventStore(':memory:');
    const bus = new EventBus(eventStore);
    const projStore = new ProjectionsStore(':memory:');
    const spy = makeSpyProjection();
    const runner = new ProjectionRunner(bus, eventStore, projStore, [spy as any]);
    runner.start();
    bus.publish({ seq: null, timestamp: Date.now(), subject: { kind: 'agent', agentId: 'a' }, family: 'task', subtype: 'created', handles: {}, payload: {}, value: null });
    expect(spy.getReceived()).toEqual(['created']);
    // 再次重放，不应重复
    runner.replayAll();
    expect(spy.getReceived()).toEqual(['created']); // 清空后重放，只有1条
    runner.stop();
    projStore.close();
    eventStore.close();
  });
});
