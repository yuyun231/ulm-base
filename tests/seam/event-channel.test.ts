import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventChannel } from '../../src/seam/event-channel.js';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { createInMemoryPair } from '../../src/seam/in-memory-transport.js';

function setup() {
  const eventStore = new EventStore(':memory:');
  const bus = new EventBus(eventStore);
  const { server, client } = createInMemoryPair();
  const channel = new EventChannel(bus, server);
  channel.start();
  return { eventStore, bus, server, client, channel };
}

describe('EventChannel 事件流通道', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { ctx.channel.stop(); ctx.eventStore.close(); });

  it('内核发 organ action 事件→基座落库+回 ack', () => {
    const acks: any[] = [];
    ctx.client.onMessage((msg) => { if (msg.channel === 'event' && (msg.payload as any).type === 'ack') acks.push(msg.payload); });
    ctx.client.send({
      channel: 'event',
      payload: {
        type: 'emit',
        event: {
          timestamp: Date.now(),
          subject: { kind: 'agent', agentId: 'res-01' },
          family: 'organ', subtype: 'action',
          handles: {}, payload: { action: 'write' }, value: null,
        },
      },
    });
    // 事件应落库
    const organEvents = ctx.eventStore.getByFamily('organ');
    expect(organEvents).toHaveLength(1);
    expect(organEvents[0].subtype).toBe('action');
    // 应回 ack（含 seq）
    expect(acks).toHaveLength(1);
    expect(acks[0].seq).toBe(1);
  });

  it('内核发 dialogue turnPosted 事件→基座落库', () => {
    ctx.client.send({
      channel: 'event',
      payload: {
        type: 'emit',
        event: {
          timestamp: Date.now(),
          subject: { kind: 'agent', agentId: 'res-01' },
          family: 'dialogue', subtype: 'turnPosted',
          handles: { dialogueId: 'd1' }, payload: { channel: 'task', content: 'hi' }, value: null,
        },
      },
    });
    const dialogueEvents = ctx.eventStore.getByFamily('dialogue');
    expect(dialogueEvents).toHaveLength(1);
  });

  it('非法事件族被拒绝（不落库，回错误 ack）', () => {
    const acks: any[] = [];
    ctx.client.onMessage((msg) => { if ((msg.payload as any).type === 'ack') acks.push(msg.payload); });
    ctx.client.send({
      channel: 'event',
      payload: {
        type: 'emit',
        event: {
          timestamp: Date.now(),
          subject: { kind: 'agent', agentId: 'res-01' },
          family: 'invalid', subtype: 'x',
          handles: {}, payload: {}, value: null,
        } as any,
      },
    });
    expect(ctx.eventStore.getMaxSeq()).toBe(0);
    expect(acks).toHaveLength(1);
    expect(acks[0].error).toBeDefined();
  });
});
