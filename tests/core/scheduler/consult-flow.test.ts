import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { ProjectionsStore } from '../../src/core/projector/projections-store.js';
import { ProjectionRunner } from '../../src/core/projector/runner.js';
import { SchedulerRules } from '../../src/core/scheduler/rules.js';
import { ConcurrencyGate } from '../../src/core/scheduler/concurrency-gate.js';
import { LoadQueue } from '../../src/core/scheduler/load-queue.js';
import { TimerService } from '../../src/core/scheduler/timer.js';
import { ConsultsProjection } from '../../src/core/projector/projections/consults.js';
import { TasksProjection } from '../../src/core/projector/projections/tasks.js';
import { AgentsProjection } from '../../src/core/projector/projections/agents.js';
import { createInMemoryPair } from '../../src/seam/in-memory-transport.js';
import { ControlChannel } from '../../src/seam/control-channel.js';
import { TaskCommands } from '../../src/services/task/commands.js';
import type { TransportMessage } from '../../src/seam/transport.js';

describe('F1 征求决策四步流转 — 调度器投递+回传链路', () => {
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
      new ConsultsProjection(),
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
      compressThreshold: 1000, // 高阈值：本测试不涉 F2/F3 链路
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

  it('consultInitiated 事件 → 调度器产 inject 指令投递征求任务给方案助手', () => {
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

    // 验证：调度器消费 consultInitiated 后产 inject 控制流指令到方案助手
    const controlMsgs = sentMessages.filter(m => {
      const p = m.payload as any;
      return p.command === 'inject' && p.agentId === 'plan-assistant';
    });
    expect(controlMsgs.length).toBeGreaterThan(0);
    // inject 载荷只含答案文本？不——投递阶段是投递征求任务，载荷含 question
    // 回传阶段才是只含答案文本
    const injectPayload = (controlMsgs[0].payload as any);
    expect(injectPayload.question).toBe('路径不确定');
    expect(injectPayload.dialogueId).toBeDefined(); // 方案对话id
  });

  it('consultAnswered 事件 → 调度器产 inject 指令回传答案给发起方原对话', () => {
    // 先发起
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
    sentMessages = []; // 清空投递阶段的指令

    // 作答
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId: 'plan-assistant' },
      family: 'comm', subtype: 'consultAnswered',
      handles: { taskId: 'consult-task-1' },
      payload: { answer: '建议走方案B' },
      value: null,
    });

    // 验证：调度器消费 consultAnswered 后产 inject 回传答案到发起方原对话
    const controlMsgs = sentMessages.filter(m => {
      const p = m.payload as any;
      return p.command === 'inject' && p.agentId === 'res-01';
    });
    expect(controlMsgs.length).toBeGreaterThan(0);
    // inject 载荷只含答案文本
    const injectPayload = (controlMsgs[0].payload as any);
    expect(injectPayload.content).toBe('建议走方案B');
    expect(injectPayload.dialogueId).toBe('dlg-1'); // 回传到原对话
  });
});
