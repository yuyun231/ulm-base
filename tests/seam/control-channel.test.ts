import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ControlChannel, CONTROL_COMMANDS } from '../../src/seam/control-channel.js';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { createInMemoryPair } from '../../src/seam/in-memory-transport.js';

function setup() {
  const eventStore = new EventStore(':memory:');
  const bus = new EventBus(eventStore);
  const { server, client } = createInMemoryPair();
  const channel = new ControlChannel(bus, server);
  channel.start();
  return { eventStore, bus, server, client, channel };
}

describe('ControlChannel 控制流通道', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { ctx.channel.stop(); ctx.eventStore.close(); });

  it('CONTROL_COMMANDS 含11个指令', () => {
    expect(CONTROL_COMMANDS).toHaveLength(11);
    expect(CONTROL_COMMANDS).toContain('wake');
    expect(CONTROL_COMMANDS).toContain('sleep');
    expect(CONTROL_COMMANDS).toContain('interrupt');
    expect(CONTROL_COMMANDS).toContain('correct');
    expect(CONTROL_COMMANDS).toContain('inject');
  });

  it('sendCommand 发 wake 指令：内核收到 + 落 piercingIssued 事件', () => {
    const received: any[] = [];
    ctx.client.onMessage((msg) => { if (msg.channel === 'control') received.push(msg.payload); });
    ctx.channel.sendCommand('human:u1', 'res-01', 'wake', { taskId: 't1' });
    // 内核应收到 control 指令
    expect(received).toHaveLength(1);
    expect(received[0].command).toBe('wake');
    // 落 piercingIssued 管理操作事件（澄清8：fire-and-forget + 落事件）
    const adminEvents = ctx.eventStore.getByFamily('admin');
    expect(adminEvents.find(e => e.subtype === 'piercingIssued')).toBeDefined();
  });

  it('sendCommand 发 correct 指令（含指导，标最高优先级）', () => {
    ctx.channel.sendCommand('human:u1', 'res-01', 'correct', { guidance: '修正方向' });
    const adminEvents = ctx.eventStore.getByFamily('admin');
    expect(adminEvents[0].payload as any).toMatchObject({ type: 'correct', agentId: 'res-01' });
  });

  it('sendCommand 发 modelConfig 下发', () => {
    ctx.channel.sendCommand('human:u1', 'res-01', 'modelConfig', { model: 'gpt-4' });
    const adminEvents = ctx.eventStore.getByFamily('admin');
    expect((adminEvents[0].payload as any).type).toBe('modelConfig');
  });

  it('receiveAck 收到内核回执→落 piercingAcked 事件', () => {
    ctx.channel.sendCommand('human:u1', 'res-01', 'wake', {});
    // 模拟内核回执
    ctx.client.send({
      channel: 'control',
      payload: { type: 'ack', commandId: 'cmd-1', agentId: 'res-01', success: true, detail: '生效' },
    });
    const adminEvents = ctx.eventStore.getByFamily('admin');
    expect(adminEvents.find(e => e.subtype === 'piercingAcked')).toBeDefined();
  });
});
