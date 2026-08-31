import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GuidancesProjection } from '../../../src/core/projector/projections/guidances.js';
import { ProjectionsStore } from '../../../src/core/projector/projections-store.js';
import { EventStore } from '../../../src/core/event-bus/store.js';
import { EventBus } from '../../../src/core/event-bus/bus.js';
import { ProjectionRunner } from '../../../src/core/projector/runner.js';

describe('GuidancesProjection F5 补完', () => {
  let projStore: ProjectionsStore;
  let eventStore: EventStore;
  let bus: EventBus;
  let runner: ProjectionRunner;

  beforeEach(() => {
    projStore = new ProjectionsStore(':memory:');
    eventStore = new EventStore(':memory:');
    bus = new EventBus(eventStore);
    runner = new ProjectionRunner(bus, eventStore, projStore, [new GuidancesProjection()]);
    runner.start();
  });

  afterEach(() => {
    runner.stop();
    projStore.close();
    eventStore.close();
  });

  it('guidanceIssued 事件落 guidances 投影表', () => {
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'user-1' },
      family: 'task', subtype: 'guidanceIssued',
      handles: { taskId: 'task-1' },
      payload: { guidanceId: 'g-1', content: '请走方案A', type: 'now' },
      value: null,
    });

    const row = projStore.get('SELECT * FROM guidances WHERE guidanceId = ?', 'g-1') as any;
    expect(row).toBeTruthy();
    expect(row.state).toBe('issued');
    expect(row.content).toBe('请走方案A');
    expect(row.type).toBe('now');
    expect(row.issuedBy).toBe('human:user-1');
  });

  it('guidanceInjected 事件更新状态为 injected', () => {
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'user-1' },
      family: 'task', subtype: 'guidanceIssued',
      handles: { taskId: 'task-1' },
      payload: { guidanceId: 'g-1', content: '请走方案A', type: 'now' },
      value: null,
    });
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'module', module: 'scheduler' },
      family: 'task', subtype: 'guidanceInjected',
      handles: { taskId: 'task-1' },
      payload: { guidanceId: 'g-1' },
      value: null,
    });

    const row = projStore.get('SELECT * FROM guidances WHERE guidanceId = ?', 'g-1') as any;
    expect(row.state).toBe('injected');
  });

  it('guidanceAcked 事件更新状态为 acked', () => {
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'user-1' },
      family: 'task', subtype: 'guidanceIssued',
      handles: { taskId: 'task-1' },
      payload: { guidanceId: 'g-1', content: '请走方案A', type: 'now' },
      value: null,
    });
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'module', module: 'scheduler' },
      family: 'task', subtype: 'guidanceInjected',
      handles: { taskId: 'task-1' },
      payload: { guidanceId: 'g-1' },
      value: null,
    });
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId: 'res-01' },
      family: 'task', subtype: 'guidanceAcked',
      handles: { taskId: 'task-1' },
      payload: { guidanceId: 'g-1', ackNote: '已理解，调整方向' },
      value: null,
    });

    const row = projStore.get('SELECT * FROM guidances WHERE guidanceId = ?', 'g-1') as any;
    expect(row.state).toBe('acked');
    expect(row.ackNote).toBe('已理解，调整方向');
  });

  it('guidanceClosed 事件更新状态为 closed', () => {
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'user-1' },
      family: 'task', subtype: 'guidanceIssued',
      handles: { taskId: 'task-1' },
      payload: { guidanceId: 'g-1', content: '请走方案A', type: 'now' },
      value: null,
    });
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'module', module: 'scheduler' },
      family: 'task', subtype: 'guidanceClosed',
      handles: { taskId: 'task-1' },
      payload: { guidanceId: 'g-1' },
      value: null,
    });

    const row = projStore.get('SELECT * FROM guidances WHERE guidanceId = ?', 'g-1') as any;
    expect(row.state).toBe('closed');
  });

  it('未来指导(type=future)不立即产 inject 指令', () => {
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'user-1' },
      family: 'task', subtype: 'guidanceIssued',
      handles: { taskId: 'task-1' },
      payload: { guidanceId: 'g-2', content: '下次注意边界检查', type: 'future' },
      value: null,
    });

    const row = projStore.get('SELECT * FROM guidances WHERE guidanceId = ?', 'g-2') as any;
    expect(row.type).toBe('future');
    expect(row.state).toBe('issued'); // 未来指导不自动 injected
  });
});
