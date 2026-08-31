import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { ProjectionsStore } from '../../src/core/projector/projections-store.js';
import { ProjectionRunner } from '../../src/core/projector/runner.js';
import { SchedulerRules } from '../../src/core/scheduler/rules.js';
import { ConcurrencyGate } from '../../src/core/scheduler/concurrency-gate.js';
import { LoadQueue } from '../../src/core/scheduler/load-queue.js';
import { TimerService } from '../../src/core/scheduler/timer.js';
import { GuidancesProjection } from '../../src/core/projector/projections/guidances.js';
import { AgentsProjection } from '../../src/core/projector/projections/agents.js';
import { TasksProjection } from '../../src/core/projector/projections/tasks.js';
import { createInMemoryPair } from '../../src/seam/in-memory-transport.js';
import { ControlChannel } from '../../src/seam/control-channel.js';
import { TaskCommands } from '../../src/services/task/commands.js';
import type { TransportMessage } from '../../src/seam/transport.js';

describe('F5 指导闭环 — 注入链路', () => {
  let eventStore: EventStore;
  let bus: EventBus;
  let projStore: ProjectionsStore;
  let runner: ProjectionRunner;
  let rules: SchedulerRules;
  let controlChannel: ControlChannel;
  let sentMessages: TransportMessage[];

  beforeEach(() => {
    eventStore = new EventStore(':memory:');
    bus = new EventBus(eventStore);
    projStore = new ProjectionsStore(':memory:');
    runner = new ProjectionRunner(bus, eventStore, projStore, [
      new TasksProjection(),
      new AgentsProjection(),
      new GuidancesProjection(),
    ]);
    runner.start();

    const { server, client } = createInMemoryPair();
    sentMessages = [];
    client.onMessage((msg: TransportMessage) => {
      if (msg.channel === 'control') sentMessages.push(msg);
    });

    controlChannel = new ControlChannel(bus, server);
    controlChannel.start();

    const gate = new ConcurrencyGate(4);
    const loadQueue = new LoadQueue();
    const timer = new TimerService(bus, {
      sleepCountdownSec: 60, heartbeatIntervalSec: 30, heartbeatTimeoutSec: 90,
    });
    // Phase 0 修复③：调度器派发走命令面——测试配 module:scheduler 放行规则
    const taskCommands = new TaskCommands(bus, [
      { subject: 'module:scheduler', action: 'task:assign', object: '*', decision: 'allow' },
    ] as any);
    rules = new SchedulerRules(bus, projStore, gate, loadQueue, timer, controlChannel, taskCommands, {
      compressThreshold: 1000, // 高阈值：本测试不涉 F2 链路
      injectInlineMaxBytes: 4096,
    });
    rules.start();
  });

  afterEach(() => {
    rules.stop();
    controlChannel.stop();
    runner.stop();
    projStore.close();
    eventStore.close();
  });

  it('当下指导(type=now) guidanceIssued → 调度器产 correct 指令注入 + guidanceInjected 事件', () => {
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'user-1' },
      family: 'task', subtype: 'guidanceIssued',
      handles: { taskId: 'task-1' },
      payload: { guidanceId: 'g-1', content: '请走方案A', type: 'now' },
      value: null,
    });

    // 验证：调度器产 correct 控制流指令
    const correctMsgs = sentMessages.filter(m => {
      const p = m.payload as any;
      return p.command === 'correct';
    });
    expect(correctMsgs.length).toBeGreaterThan(0);
    // correct 载荷含指导内容
    const payload = (correctMsgs[0].payload as any);
    expect(payload.guidanceId).toBe('g-1');
    expect(payload.content).toBe('请走方案A');

    // 验证：guidanceInjected 事件已落库
    const events = eventStore.query(
      "SELECT * FROM events WHERE family = 'task' AND subtype = 'guidanceInjected' AND handles->>'taskId' = 'task-1'"
    );
    expect(events.length).toBeGreaterThan(0);
  });

  it('未来指导(type=future) guidanceIssued → 不产 correct 指令，不产 guidanceInjected', () => {
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'user-1' },
      family: 'task', subtype: 'guidanceIssued',
      handles: { taskId: 'task-1' },
      payload: { guidanceId: 'g-2', content: '下次注意边界', type: 'future' },
      value: null,
    });

    const correctMsgs = sentMessages.filter(m => {
      const p = m.payload as any;
      return p.command === 'correct';
    });
    expect(correctMsgs.length).toBe(0);

    const events = eventStore.query(
      "SELECT * FROM events WHERE family = 'task' AND subtype = 'guidanceInjected'"
    );
    expect(events.length).toBe(0);
  });

  it('guidanceAcked → guidanceClosed（任务完成时闭环已有指导）', () => {
    // 发起指导
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'user-1' },
      family: 'task', subtype: 'guidanceIssued',
      handles: { taskId: 'task-1' },
      payload: { guidanceId: 'g-1', content: '请走方案A', type: 'now' },
      value: null,
    });
    // agent 回执
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId: 'res-01' },
      family: 'task', subtype: 'guidanceAcked',
      handles: { taskId: 'task-1' },
      payload: { guidanceId: 'g-1', ackNote: '已理解' },
      value: null,
    });

    // 验证 guidances 投影表状态
    const row = projStore.get('SELECT * FROM guidances WHERE guidanceId = ?', 'g-1') as any;
    expect(row.state).toBe('acked');
  });
});
