import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HandshakeChannel } from '../../src/seam/handshake.js';
import { ConnectionRegistry } from '../../src/seam/connection-registry.js';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { ProjectionsStore } from '../../src/core/projector/projections-store.js';
import { AgentRegistryProjection } from '../../src/core/projector/projections/agent-registry.js';
import { createInMemoryPair } from '../../src/seam/in-memory-transport.js';

function seedAgent(projStore: ProjectionsStore, agentId: string, opts: { enabled?: boolean; capabilities?: string[] } = {}) {
  const proj = new AgentRegistryProjection();
  proj.initSchema(projStore);
  proj.applyEvent(projStore, {
    seq: 1, timestamp: Date.now(),
    subject: { kind: 'human', userId: 'admin-1' }, family: 'admin', subtype: 'agentRegistered',
    handles: {}, payload: { agentId, role: 'r', capabilities: opts.capabilities ?? ['cap-a'], configSource: 'factory', enabled: opts.enabled ?? true },
    value: null,
  } as any);
}

describe('HandshakeChannel 白名单准入（Phase F.1 D1/D3）', () => {
  let eventStore: EventStore;
  let bus: EventBus;
  let projStore: ProjectionsStore;
  let server: any;
  let client: any;
  let registry: ConnectionRegistry;
  let channel: HandshakeChannel;

  function setup(agentOpts?: { enabled?: boolean; capabilities?: string[] }) {
    eventStore = new EventStore(':memory:');
    bus = new EventBus(eventStore);
    projStore = new ProjectionsStore(':memory:');
    seedAgent(projStore, 'res-01', agentOpts);
    const pair = createInMemoryPair();
    server = pair.server; client = pair.client;
    registry = new ConnectionRegistry();
    channel = new HandshakeChannel(bus, server, { intervalSec: 30, timeoutSec: 90 }, registry, projStore);
    channel.start();
  }

  afterEach(() => {
    channel.stop(); projStore.close(); eventStore.close();
  });

  it('已注册 agent → registered 回执 + woken + 连接绑定', () => {
    setup();
    const responses: any[] = [];
    client.onMessage((msg: any) => { if ((msg.payload as any).type === 'registered') responses.push(msg.payload); });
    client.send({ channel: 'control', payload: { type: 'register', agentId: 'res-01', role: 'r', capabilities: ['cap-a'] } });
    expect(responses).toHaveLength(1);
    expect(eventStore.getByFamily('schedule').find(e => e.subtype === 'woken')).toBeDefined();
    expect(registry.resolve('res-01')).not.toBeNull();
  });

  it('未注册 agentId → registerRejected 回执 + agentRegisterRejected 事件 + 不产 woken 不绑定', () => {
    setup();
    const responses: any[] = [];
    client.onMessage((msg: any) => { if ((msg.payload as any).type === 'registerRejected') responses.push(msg.payload); });
    client.send({ channel: 'control', payload: { type: 'register', agentId: 'ghost', role: 'r', capabilities: [] } });
    expect(responses).toHaveLength(1);
    expect(responses[0].detail).toBe('unregistered');
    expect(eventStore.getByFamily('admin').find(e => e.subtype === 'agentRegisterRejected')).toBeDefined();
    expect(eventStore.getByFamily('schedule').find(e => e.subtype === 'woken')).toBeUndefined();
    expect(registry.resolve('ghost')).toBeNull();
  });

  it('enabled=0 → 拒绝（detail=agent disabled）', () => {
    setup({ enabled: false });
    const responses: any[] = [];
    client.onMessage((msg: any) => { if ((msg.payload as any).type === 'registerRejected') responses.push(msg.payload); });
    client.send({ channel: 'control', payload: { type: 'register', agentId: 'res-01', role: 'r', capabilities: [] } });
    expect(responses).toHaveLength(1);
    expect(responses[0].detail).toBe('agent disabled');
  });

  it('capabilities 不一致 → 照常接入 + agentCapabilityMismatch 事件（D3 注册表为权威）', () => {
    setup({ capabilities: ['cap-a'] });
    const responses: any[] = [];
    client.onMessage((msg: any) => { if ((msg.payload as any).type === 'registered') responses.push(msg.payload); });
    client.send({ channel: 'control', payload: { type: 'register', agentId: 'res-01', role: 'r', capabilities: ['cap-b'] } });
    expect(responses).toHaveLength(1);
    const mismatch = eventStore.getByFamily('admin').find(e => e.subtype === 'agentCapabilityMismatch');
    expect(mismatch).toBeDefined();
    expect((mismatch!.payload as any).declared).toEqual(['cap-a']);
    expect((mismatch!.payload as any).reported).toEqual(['cap-b']);
  });
});
