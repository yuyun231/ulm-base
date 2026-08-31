import { describe, it, expect } from 'vitest';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { EventStore } from '../../src/core/event-bus/store.js';
import type { EventEnvelope } from '../../src/core/event-bus/envelope.js';

function makeEnvelope(family: string, subtype: string, payload: object = {}): EventEnvelope {
  return {
    seq: null,
    timestamp: Date.now(),
    subject: { kind: 'agent', agentId: 'res-01' },
    family: family as any,
    subtype,
    handles: {},
    payload,
    value: null,
  };
}

describe('EventBus 事件总线', () => {
  it('publish 返回 ack 含 seq', () => {
    const store = new EventStore(':memory:');
    const bus = new EventBus(store);
    const ack = bus.publish(makeEnvelope('task', 'created'));
    expect(ack.seq).toBe(1);
    store.close();
  });

  it('publish 多条 seq 单调递增', () => {
    const store = new EventStore(':memory:');
    const bus = new EventBus(store);
    const ack1 = bus.publish(makeEnvelope('task', 'created'));
    const ack2 = bus.publish(makeEnvelope('task', 'assigned'));
    const ack3 = bus.publish(makeEnvelope('schedule', 'woken'));
    expect(ack1.seq).toBe(1);
    expect(ack2.seq).toBe(2);
    expect(ack3.seq).toBe(3);
    store.close();
  });

  it('publish 广播给订阅者', () => {
    const store = new EventStore(':memory:');
    const bus = new EventBus(store);
    const received: number[] = [];
    bus.subscribe((env) => { received.push(env.seq); });
    bus.publish(makeEnvelope('task', 'created'));
    bus.publish(makeEnvelope('task', 'assigned'));
    expect(received).toEqual([1, 2]);
    store.close();
  });

  it('subscribe 返回取消订阅函数', () => {
    const store = new EventStore(':memory:');
    const bus = new EventBus(store);
    const received: number[] = [];
    const unsub = bus.subscribe((env) => { received.push(env.seq); });
    bus.publish(makeEnvelope('task', 'created'));
    unsub();
    bus.publish(makeEnvelope('task', 'assigned'));
    expect(received).toEqual([1]);
    store.close();
  });

  it('publish 非法信封抛错且不落库', () => {
    const store = new EventStore(':memory:');
    const bus = new EventBus(store);
    const bad = makeEnvelope('task', 'nonExistent');
    expect(() => bus.publish(bad)).toThrow('subtype');
    expect(store.getMaxSeq()).toBe(0);
    store.close();
  });

  it('订阅者抛错不影响其他订阅者和落库', () => {
    const store = new EventStore(':memory:');
    const bus = new EventBus(store);
    const received: number[] = [];
    bus.subscribe(() => { throw new Error('订阅者异常'); });
    bus.subscribe((env) => { received.push(env.seq); });
    bus.publish(makeEnvelope('task', 'created'));
    expect(store.getMaxSeq()).toBe(1);
    expect(received).toEqual([1]);
    store.close();
  });

  it('按过滤器订阅', () => {
    const store = new EventStore(':memory:');
    const bus = new EventBus(store);
    const taskEvents: string[] = [];
    bus.subscribe((env) => { taskEvents.push(env.subtype); }, { family: 'task' });
    bus.publish(makeEnvelope('task', 'created'));
    bus.publish(makeEnvelope('schedule', 'woken'));
    bus.publish(makeEnvelope('task', 'assigned'));
    expect(taskEvents).toEqual(['created', 'assigned']);
    store.close();
  });
});
