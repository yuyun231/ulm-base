import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProjectionsStore } from '../../../src/core/projector/projections-store.js';
import { PurposesProjection } from '../../../src/core/projector/projections/purposes.js';
import { EventStore } from '../../../src/core/event-bus/store.js';
import { EventBus } from '../../../src/core/event-bus/bus.js';
import { ProjectionRunner } from '../../../src/core/projector/runner.js';
import type { StoredEventEnvelope } from '../../../src/core/event-bus/envelope.js';

function makeEvent(seq: number, family: string, subtype: string, handles: object = {}, payload: object = {}): StoredEventEnvelope {
  return { seq, timestamp: Date.now(), subject: { kind: 'agent', agentId: 'res-01' }, family: family as any, subtype, handles, payload, value: null } as StoredEventEnvelope;
}

describe('PurposesProjection 目的投影（占位）', () => {
  let projStore: ProjectionsStore;
  let proj: PurposesProjection;

  beforeEach(() => {
    projStore = new ProjectionsStore(':memory:');
    proj = new PurposesProjection();
    proj.initSchema(projStore);
  });

  it('initSchema 建表', () => {
    const tables = projStore.all("SELECT name FROM sqlite_master WHERE type='table' AND name='purposes'") as any[];
    expect(tables).toHaveLength(1);
  });

  it('applyEvent 不抛异常（占位空实现）', () => {
    expect(() => proj.applyEvent(projStore, makeEvent(1, 'task', 'created', { purposeId: 'purp-1' }))).not.toThrow();
  });
});

describe('PurposesProjection F10 补完', () => {
  let projStore: ProjectionsStore;
  let eventStore: EventStore;
  let bus: EventBus;
  let runner: ProjectionRunner;

  beforeEach(() => {
    projStore = new ProjectionsStore(':memory:');
    eventStore = new EventStore(':memory:');
    bus = new EventBus(eventStore);
    runner = new ProjectionRunner(bus, eventStore, projStore, [new PurposesProjection()]);
    runner.start();
  });

  afterEach(() => { runner.stop(); projStore.close(); eventStore.close(); });

  it('purposeCreated 事件创建目的记录（state=draft）', () => {
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'user-1' },
      family: 'task', subtype: 'purposeCreated',
      handles: { purposeId: 'p1' },
      payload: { dialogueId: 'dlg-1', description: '做一个工具' },
      value: null,
    });

    const row = projStore.get('SELECT * FROM purposes WHERE purposeId = ?', 'p1') as any;
    expect(row).toBeTruthy();
    expect(row.state).toBe('draft');
    expect(row.dialogueId).toBe('dlg-1');
  });

  it('purposeConfirmed 事件推进状态机', () => {
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'user-1' },
      family: 'task', subtype: 'purposeCreated',
      handles: { purposeId: 'p1' },
      payload: { dialogueId: 'dlg-1', description: '做工具' },
      value: null,
    });
    // 计划测试缺陷适配（测试3/4输入序列相同但期望矛盾，按线性状态机逐级推进）：先逐级 confirm 再到 valueConfirmed
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'user-1' },
      family: 'task', subtype: 'purposeConfirmed',
      handles: { purposeId: 'p1' },
      payload: { confirmedState: 'refining' },
      value: null,
    });
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'user-1' },
      family: 'task', subtype: 'purposeConfirmed',
      handles: { purposeId: 'p1' },
      payload: { confirmedState: 'valueConfirmed' },
      value: null,
    });

    const row = projStore.get('SELECT * FROM purposes WHERE purposeId = ?', 'p1') as any;
    expect(row.state).toBe('valueConfirmed');
  });

  it('purposeLaunched 事件设置 state=launched + 关联 taskId', () => {
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'user-1' },
      family: 'task', subtype: 'purposeCreated',
      handles: { purposeId: 'p1' },
      payload: { dialogueId: 'dlg-1', description: '做工具' },
      value: null,
    });
    // 计划测试缺陷适配（同上，线性状态机逐级推进后再 launch，与 D.3 命令面测试一致）
    for (const s of ['refining', 'valueConfirmed', 'pathConfirmed', 'detailsReady']) {
      bus.publish({
        seq: null, timestamp: Date.now(),
        subject: { kind: 'human', userId: 'user-1' },
        family: 'task', subtype: 'purposeConfirmed',
        handles: { purposeId: 'p1' },
        payload: { confirmedState: s },
        value: null,
      });
    }
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'user-1' },
      family: 'task', subtype: 'purposeLaunched',
      handles: { purposeId: 'p1', taskId: 'task-1' },
      payload: {},
      value: null,
    });

    const row = projStore.get('SELECT * FROM purposes WHERE purposeId = ?', 'p1') as any;
    expect(row.state).toBe('launched');
    expect(row.taskId).toBe('task-1');
  });

  it('状态机转换约束：draft → refining → valueConfirmed → pathConfirmed → detailsReady → launched', () => {
    // 这个测试验证状态机不跳级（非法转换被拒绝）
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'user-1' },
      family: 'task', subtype: 'purposeCreated',
      handles: { purposeId: 'p1' },
      payload: { dialogueId: 'dlg-1', description: '做工具' },
      value: null,
    });
    // 尝试跳级到 launched（非法）
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'user-1' },
      family: 'task', subtype: 'purposeLaunched',
      handles: { purposeId: 'p1', taskId: 'task-1' },
      payload: {},
      value: null,
    });

    const row = projStore.get('SELECT * FROM purposes WHERE purposeId = ?', 'p1') as any;
    // 非法转换被忽略，state 仍为 draft
    expect(row.state).toBe('draft');
  });
});
