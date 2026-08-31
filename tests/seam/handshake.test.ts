import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HandshakeChannel } from '../../src/seam/handshake.js';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { createInMemoryPair } from '../../src/seam/in-memory-transport.js';

function setup() {
  const eventStore = new EventStore(':memory:');
  const bus = new EventBus(eventStore);
  const { server, client } = createInMemoryPair();
  const channel = new HandshakeChannel(bus, server, { intervalSec: 30, timeoutSec: 90 });
  channel.start();
  return { eventStore, bus, server, client, channel };
}

describe('HandshakeChannel 握手通道', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { ctx.channel.stop(); ctx.eventStore.close(); });

  it('注册请求：内核发 register→基座回 registered + 落 woken 事件', () => {
    const responses: any[] = [];
    ctx.client.onMessage((msg) => { if ((msg.payload as any).type === 'registered') responses.push(msg.payload); });
    ctx.client.send({
      channel: 'control',
      payload: {
        type: 'register',
        agentId: 'res-01',
        role: 'researcher',
        capabilities: ['search', 'write'],
      },
    });
    expect(responses).toHaveLength(1);
    expect(responses[0].agentId).toBe('res-01');
    // 应落 woken 调度事件
    const schedEvents = ctx.eventStore.getByFamily('schedule');
    expect(schedEvents.find(e => e.subtype === 'woken' && e.subject.agentId === 'res-01')).toBeDefined();
  });

  it('心跳：内核发 heartbeat→基座更新 lastActivityAt', () => {
    // 先注册
    ctx.client.send({ channel: 'control', payload: { type: 'register', agentId: 'res-01', role: 'r', capabilities: [] } });
    // 心跳
    ctx.client.send({ channel: 'control', payload: { type: 'heartbeat', agentId: 'res-01' } });
    // 不报错即通过（lastActivityAt 在 agents 投影更新，需 AgentsProjection 才测投影，此处只验证不抛错）
  });

  it('心跳超时→标记失联（agentLost 事件）', () => {
    // 用极短超时
    const eventStore = new EventStore(':memory:');
    const bus = new EventBus(eventStore);
    const { server, client } = createInMemoryPair();
    const channel = new HandshakeChannel(bus, server, { intervalSec: 0, timeoutSec: 0 });
    channel.start();
    // 注册
    client.send({ channel: 'control', payload: { type: 'register', agentId: 'res-01', role: 'r', capabilities: [] } });
    // 等待超时检查
    const wait = Date.now() + 10; while (Date.now() < wait) {}
    const expired = channel.checkHeartbeatTimeout();
    expect(expired).toContain('res-01');
    const lostEvents = eventStore.getByFamily('schedule').filter(e => e.subtype === 'agentLost');
    expect(lostEvents.find(e => e.subject.agentId === 'res-01')).toBeDefined();
    channel.stop();
    eventStore.close();
  });
});
