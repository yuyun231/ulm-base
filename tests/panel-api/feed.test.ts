import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FeedbackFeed } from '../../src/panel-api/feed.js';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';

function setup() {
  const eventStore = new EventStore(':memory:');
  const bus = new EventBus(eventStore);
  const feed = new FeedbackFeed(bus, { keyNodeEvents: ['task:created', 'task:nodeJudged'] });
  feed.start();
  return { eventStore, bus, feed };
}

describe('FeedbackFeed 反馈区', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { ctx.feed.stop(); ctx.eventStore.close(); });

  it('订阅关键节点事件：task:created 推送', () => {
    const received: string[] = [];
    ctx.feed.onPush((item) => { received.push(item.subtype); });
    ctx.bus.publish({ seq: null, timestamp: Date.now(), subject: { kind: 'human', userId: 'u1' }, family: 'task', subtype: 'created', handles: { taskId: 't1' }, payload: {}, value: null });
    expect(received).toContain('created');
  });

  it('非关键节点事件不推送：task:assigned 不在 keyNodeEvents', () => {
    const received: string[] = [];
    ctx.feed.onPush((item) => { received.push(item.subtype); });
    ctx.bus.publish({ seq: null, timestamp: Date.now(), subject: { kind: 'module', module: 'task-service' }, family: 'task', subtype: 'assigned', handles: { taskId: 't1' }, payload: {}, value: null });
    expect(received).toHaveLength(0);
  });

  it('按 agent 过滤订阅', () => {
    const received: string[] = [];
    ctx.feed.onPush((item) => { received.push(item.subtype); }, { agentId: 'res-01' });
    ctx.bus.publish({ seq: null, timestamp: Date.now(), subject: { kind: 'agent', agentId: 'res-02' }, family: 'schedule', subtype: 'woken', handles: {}, payload: {}, value: null });
    expect(received).toHaveLength(0);
  });

  it('关键节点事件含文案', () => {
    const items: any[] = [];
    ctx.feed.onPush((item) => { items.push(item); });
    ctx.bus.publish({ seq: null, timestamp: Date.now(), subject: { kind: 'human', userId: 'u1' }, family: 'task', subtype: 'created', handles: { taskId: 't1' }, payload: { goal: '测试' }, value: null });
    expect(items[0].message).toBeDefined();
  });
});
