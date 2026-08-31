import { describe, it, expect } from 'vitest';
import { EventStore } from '../../src/core/event-bus/store.js';
import type { EventEnvelope } from '../../src/core/event-bus/envelope.js';

function makeEnvelope(seq: number | null, family: string, subtype: string): EventEnvelope {
  return {
    seq,
    timestamp: Date.now(),
    subject: { kind: 'agent', agentId: 'res-01' },
    family: family as any,
    subtype,
    handles: {},
    payload: {},
    value: null,
  };
}

describe('EventStore append-only 存储', () => {
  it('创建内存库无异常', () => {
    const store = new EventStore(':memory:');
    store.close();
  });

  it('追加事件后可按 seq 查询', () => {
    const store = new EventStore(':memory:');
    const stored = store.append({ ...makeEnvelope(null, 'task', 'created'), seq: 1 });
    expect(stored.seq).toBe(1);
    const got = store.getBySeq(1);
    expect(got).toBeDefined();
    expect(got!.subtype).toBe('created');
    store.close();
  });

  it('获取当前 max seq', () => {
    const store = new EventStore(':memory:');
    expect(store.getMaxSeq()).toBe(0);
    store.append({ ...makeEnvelope(null, 'task', 'created'), seq: 1 });
    store.append({ ...makeEnvelope(null, 'task', 'assigned'), seq: 2 });
    expect(store.getMaxSeq()).toBe(2);
    store.close();
  });

  it('按 seq 范围查询', () => {
    const store = new EventStore(':memory:');
    for (let i = 1; i <= 5; i++) {
      store.append({ ...makeEnvelope(null, 'task', 'created'), seq: i });
    }
    const range = store.getRange(2, 4);
    expect(range).toHaveLength(3);
    expect(range[0].seq).toBe(2);
    expect(range[2].seq).toBe(4);
    store.close();
  });

  it('append-only：无 update 方法', () => {
    const store = new EventStore(':memory:');
    expect((store as any).update).toBeUndefined();
    expect((store as any).delete).toBeUndefined();
    store.close();
  });

  it('重复 seq 追加抛错', () => {
    const store = new EventStore(':memory:');
    store.append({ ...makeEnvelope(null, 'task', 'created'), seq: 1 });
    expect(() => store.append({ ...makeEnvelope(null, 'task', 'assigned'), seq: 1 })).toThrow();
    store.close();
  });

  it('按 family 查询', () => {
    const store = new EventStore(':memory:');
    store.append({ ...makeEnvelope(null, 'task', 'created'), seq: 1 });
    store.append({ ...makeEnvelope(null, 'schedule', 'woken'), seq: 2 });
    store.append({ ...makeEnvelope(null, 'task', 'assigned'), seq: 3 });
    const taskEvents = store.getByFamily('task');
    expect(taskEvents).toHaveLength(2);
    store.close();
  });
});
