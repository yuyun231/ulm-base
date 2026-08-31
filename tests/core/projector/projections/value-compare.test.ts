import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProjectionsStore } from '../../../src/core/projector/projections-store.js';
import { ValueCompareProjection } from '../../../src/core/projector/projections/value-compare.js';
import { EventStore } from '../../../src/core/event-bus/store.js';
import { EventBus } from '../../../src/core/event-bus/bus.js';
import { ProjectionRunner } from '../../../src/core/projector/runner.js';
import type { StoredEventEnvelope } from '../../../src/core/event-bus/envelope.js';

function makeEvent(): StoredEventEnvelope {
  return { seq: 1, timestamp: Date.now(), subject: { kind: 'agent', agentId: 'res-01' }, family: 'task', subtype: 'created', handles: {}, payload: {}, value: null } as StoredEventEnvelope;
}

describe('ValueCompareProjection 价值比较投影（占位）', () => {
  let projStore: ProjectionsStore;
  let proj: ValueCompareProjection;

  beforeEach(() => {
    projStore = new ProjectionsStore(':memory:');
    proj = new ValueCompareProjection();
    proj.initSchema(projStore);
  });

  it('initSchema 建表', () => {
    const tables = projStore.all("SELECT name FROM sqlite_master WHERE type='table' AND name='value_compare'") as any[];
    expect(tables).toHaveLength(1);
  });

  it('applyEvent 不抛异常（占位空实现）', () => {
    expect(() => proj.applyEvent(projStore, makeEvent())).not.toThrow();
  });
});

describe('ValueCompareProjection F4 补完', () => {
  let projStore: ProjectionsStore;
  let eventStore: EventStore;
  let bus: EventBus;
  let runner: ProjectionRunner;

  beforeEach(() => {
    projStore = new ProjectionsStore(':memory:');
    eventStore = new EventStore(':memory:');
    bus = new EventBus(eventStore);
    runner = new ProjectionRunner(bus, eventStore, projStore, [new ValueCompareProjection()]);
    runner.start();
  });

  afterEach(() => {
    runner.stop();
    projStore.close();
    eventStore.close();
  });

  it('piercingIssued 事件记录判定请求载荷', () => {
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId: 'res-01' },
      family: 'admin', subtype: 'piercingIssued',
      handles: { taskId: 'task-1', purposeId: 'purp-1' },
      payload: { type: 'judgeRequest', agentId: 'res-01', question: '这个方向对吗', context: '执行上下文' },
      value: null,
    });

    const rows = projStore.all('SELECT * FROM value_compare WHERE taskId = ?', 'task-1') as any[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].requestPayload).toContain('这个方向对吗');
    expect(rows[0].verdict).toBeNull(); // 尚未回执
  });

  it('piercingAcked 事件更新判定结果 + 裁决', () => {
    // 先发请求
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId: 'res-01' },
      family: 'admin', subtype: 'piercingIssued',
      handles: { taskId: 'task-1', purposeId: 'purp-1' },
      payload: { type: 'judgeRequest', agentId: 'res-01', question: '方向对吗' },
      value: null,
    });
    // 内核回执
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'module', module: 'seam' },
      family: 'admin', subtype: 'piercingAcked',
      handles: { taskId: 'task-1', purposeId: 'purp-1' },
      payload: { agentId: 'res-01', success: true, detail: '判定完成', result: 'agree', rawOutput: 'LLM思考原文...' },
      value: null,
    });

    const row = projStore.get('SELECT * FROM value_compare WHERE taskId = ? ORDER BY id DESC LIMIT 1', 'task-1') as any;
    expect(row.verdict).toBe('agree');
    expect(row.resultPayload).toContain('判定完成');
    expect(row.rawArchivePath).toBeTruthy(); // 指向 git archive 的路径
  });
});
