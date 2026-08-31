import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { ProjectionsStore } from '../../src/core/projector/projections-store.js';
import { createInMemoryPair } from '../../src/seam/in-memory-transport.js';
import { ServiceChannel } from '../../src/seam/service-channel.js';
import { ControlChannel } from '../../src/seam/control-channel.js';
import { ValueCompareProjection } from '../../src/core/projector/projections/value-compare.js';
import { ProjectionRunner } from '../../src/core/projector/runner.js';
import type { TransportLayer, TransportMessage } from '../../src/seam/transport.js';

describe('F4 价值对抗区 — judgeRequest 转发链路', () => {
  let eventStore: EventStore;
  let bus: EventBus;
  let projStore: ProjectionsStore;
  let serviceChannel: ServiceChannel;
  let controlChannel: ControlChannel;
  let client: TransportLayer;
  let server: TransportLayer;
  let sentToKernel: TransportMessage[];

  beforeEach(() => {
    eventStore = new EventStore(':memory:');
    bus = new EventBus(eventStore);
    projStore = new ProjectionsStore(':memory:');

    const pair = createInMemoryPair();
    server = pair.server;
    client = pair.client;
    sentToKernel = [];
    client.onMessage((msg: TransportMessage) => { sentToKernel.push(msg); });

    // Phase 0 修复⑩：judgeRequest 现在做 task:judge 权限检查——测试配放行规则
    const rules = [
      { subject: 'agent:*', action: 'task:judge', object: '*', decision: 'allow' },
    ] as any[];
    serviceChannel = new ServiceChannel(bus, projStore, rules, server);
    serviceChannel.start();
    controlChannel = new ControlChannel(bus, server);
    controlChannel.start();
  });

  afterEach(() => {
    serviceChannel.stop();
    controlChannel.stop();
    projStore.close();
    eventStore.close();
  });

  it('agent 发 judgeRequest → 基座产 piercingIssued + 发 judgeResult 指令到内核', () => {
    client.send({
      channel: 'service',
      payload: {
        type: 'request', requestId: 'r1', endpoint: 'judgeRequest',
        agentId: 'res-01',
        args: { taskId: 'task-1', purposeId: 'purp-1', question: '方向对吗', context: '上下文' },
      },
    } as any);

    // 验证：piercingIssued 事件落库
    const events = eventStore.query("SELECT * FROM events WHERE family = 'admin' AND subtype = 'piercingIssued'");
    expect(events.length).toBeGreaterThan(0);

    // 验证：judgeResult 指令已发到内核
    const judgeMsgs = sentToKernel.filter(m => {
      const p = m.payload as any;
      return p.command === 'judgeResult';
    });
    expect(judgeMsgs.length).toBeGreaterThan(0);
    const payload = judgeMsgs[0].payload as any;
    expect(payload.agentId).toBe('res-01');
    expect(payload.question).toBe('方向对吗');
  });

  it('指令载荷与事件载荷一致（taskId/purposeId/nodeId/commandId 贯通）', () => {
    client.send({
      channel: 'service',
      payload: {
        type: 'request', requestId: 'r2', endpoint: 'judgeRequest',
        agentId: 'res-02',
        args: { taskId: 'task-2', purposeId: 'purp-2', nodeId: 'node-1', question: '要不要改方向' },
      },
    } as any);

    const events = eventStore.query("SELECT * FROM events WHERE family = 'admin' AND subtype = 'piercingIssued'");
    const issuedPayload = JSON.parse((events[0] as any).payload);
    expect(issuedPayload.type).toBe('judgeRequest');
    expect(issuedPayload.agentId).toBe('res-02');
    expect(issuedPayload.question).toBe('要不要改方向');

    const judgeMsgs = sentToKernel.filter(m => (m.payload as any).command === 'judgeResult');
    expect(judgeMsgs.length).toBe(1);
    const cmdPayload = judgeMsgs[0].payload as any;
    expect(cmdPayload.type).toBe('command');
    expect(cmdPayload.taskId).toBe('task-2');
    expect(cmdPayload.purposeId).toBe('purp-2');
    // Phase 0 修复①：commandId 贯通 piercingIssued ↔ 线载指令，nodeId 透传（判定转换需要）
    expect(cmdPayload.commandId).toBeTruthy();
    expect(cmdPayload.commandId).toBe(issuedPayload.commandId);
    expect(cmdPayload.nodeId).toBe('node-1');
    expect(issuedPayload.nodeId).toBe('node-1');
  });

  it('端到端：内核回执 ack（含 taskId/purposeId）→ piercingAcked 落 handles → 投影裁决落地', () => {
    // 投影装配（监听 piercingAcked 更新 value_compare）
    const vc = new ValueCompareProjection();
    vc.initSchema(projStore);
    const runner = new ProjectionRunner(bus, eventStore, projStore, [vc]);
    runner.start();

    try {
      // 1. agent 发 judgeRequest（基座转发，产 piercingIssued → 投影记录）
      client.send({
        channel: 'service',
        payload: {
          type: 'request', requestId: 'r3', endpoint: 'judgeRequest',
          agentId: 'res-03',
          args: { taskId: 'task-e2e', purposeId: 'purp-e2e', question: '这个方案行吗' },
        },
      } as any);

      // 2. 内核侧收到 judgeResult 指令后回 ack（原样回传 taskId/purposeId）
      const judgeMsgs = sentToKernel.filter(m => (m.payload as any).command === 'judgeResult');
      expect(judgeMsgs.length).toBe(1);
      const cmd = judgeMsgs[0].payload as any;
      client.send({
        channel: 'control',
        payload: { type: 'ack', commandId: cmd.commandId, agentId: 'res-03', success: true,
          taskId: cmd.taskId, purposeId: cmd.purposeId, result: 'agree', detail: '判定完成' },
      } as any);

      // 3. 裁决落地：按 taskId 匹配到请求记录并写入 verdict
      const row = projStore.get(
        'SELECT * FROM value_compare WHERE taskId = ? ORDER BY id DESC LIMIT 1', 'task-e2e') as any;
      expect(row).toBeTruthy();
      expect(row.verdict).toBe('agree');
      expect(row.resultPayload).toContain('判定完成');
      expect(row.judgedAt).toBeTruthy();
    } finally {
      runner.stop();
    }
  });

  it('Phase 0 修复⑩：无 task:judge 权限的 agent 发 judgeRequest → 拒绝且不产事件不发指令', () => {
    serviceChannel.stop(); // 停掉带放行规则的主通道，避免同一传输层消息被重复处理
    const denyChannel = new ServiceChannel(bus, projStore, [], server);
    denyChannel.start();
    try {
      client.send({
        channel: 'service',
        payload: {
          type: 'request', requestId: 'r4', endpoint: 'judgeRequest',
          agentId: 'res-no-perm',
          args: { taskId: 'task-x', purposeId: 'purp-x', question: 'q' },
        },
      } as any);

      const events = eventStore.query("SELECT * FROM events WHERE family = 'admin' AND subtype = 'piercingIssued'");
      expect(events.length).toBe(0);
      expect(sentToKernel.filter(m => (m.payload as any).command === 'judgeResult').length).toBe(0);
    } finally {
      denyChannel.stop();
    }
  });
});
