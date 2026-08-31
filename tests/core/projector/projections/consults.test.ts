import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConsultsProjection } from '../../../src/core/projector/projections/consults.js';
import { ProjectionsStore } from '../../../src/core/projector/projections-store.js';
import { EventStore } from '../../../src/core/event-bus/store.js';
import { EventBus } from '../../../src/core/event-bus/bus.js';
import { ProjectionRunner } from '../../../src/core/projector/runner.js';

describe('ConsultsProjection F1 补完', () => {
  let projStore: ProjectionsStore;
  let eventStore: EventStore;
  let bus: EventBus;
  let runner: ProjectionRunner;

  beforeEach(() => {
    projStore = new ProjectionsStore(':memory:');
    eventStore = new EventStore(':memory:');
    bus = new EventBus(eventStore);
    runner = new ProjectionRunner(bus, eventStore, projStore, [new ConsultsProjection()]);
    runner.start();
  });

  afterEach(() => {
    runner.stop();
    projStore.close();
    eventStore.close();
  });

  it('consultInitiated 事件落 consults 投影表', () => {
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId: 'res-01' },
      family: 'comm', subtype: 'consultInitiated',
      handles: { taskId: 'consult-task-1' },
      payload: {
        aggregateTaskId: 'agg-1',
        question: '路径不确定',
        initiatorAgentId: 'res-01',
        sourceDialogueId: 'dlg-1',
        sourceTaskId: 'subtask-1',
        targetAgentId: 'plan-assistant',
      },
      value: null,
    });

    const row = projStore.get('SELECT * FROM consults WHERE consultId = ?', 'consult-task-1') as any;
    expect(row).toBeTruthy();
    expect(row.state).toBe('initiated');
    expect(row.initiatorAgentId).toBe('res-01');
    expect(row.sourceDialogueId).toBe('dlg-1');
    expect(row.sourceTaskId).toBe('subtask-1');
    expect(row.targetAgentId).toBe('plan-assistant');
    expect(row.aggregateTaskId).toBe('agg-1');
  });

  it('consultAnswered 事件更新 consults 状态为 answered', () => {
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId: 'res-01' },
      family: 'comm', subtype: 'consultInitiated',
      handles: { taskId: 'consult-task-1' },
      payload: {
        aggregateTaskId: 'agg-1', question: '路径不确定',
        initiatorAgentId: 'res-01', sourceDialogueId: 'dlg-1',
        sourceTaskId: 'subtask-1', targetAgentId: 'plan-assistant',
      },
      value: null,
    });
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId: 'plan-assistant' },
      family: 'comm', subtype: 'consultAnswered',
      handles: { taskId: 'consult-task-1' },
      payload: { answer: '建议走方案B' },
      value: null,
    });

    const row = projStore.get('SELECT * FROM consults WHERE consultId = ?', 'consult-task-1') as any;
    expect(row.state).toBe('answered');
    expect(row.answer).toBe('建议走方案B');
  });

  it('consultRejected 事件更新 consults 状态为 rejected', () => {
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId: 'res-01' },
      family: 'comm', subtype: 'consultInitiated',
      handles: { taskId: 'consult-task-1' },
      payload: {
        aggregateTaskId: 'agg-1', question: '路径不确定',
        initiatorAgentId: 'res-01', sourceDialogueId: 'dlg-1',
        sourceTaskId: 'subtask-1', targetAgentId: 'plan-assistant',
      },
      value: null,
    });
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId: 'plan-assistant' },
      family: 'comm', subtype: 'consultRejected',
      handles: { taskId: 'consult-task-1' },
      payload: { reason: '问题不明确' },
      value: null,
    });

    const row = projStore.get('SELECT * FROM consults WHERE consultId = ?', 'consult-task-1') as any;
    expect(row.state).toBe('rejected');
  });
});
