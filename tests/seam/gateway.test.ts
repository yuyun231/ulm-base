import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SeamGateway } from '../../src/seam/gateway.js';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { ProjectionsStore } from '../../src/core/projector/projections-store.js';
import { createInMemoryPair } from '../../src/seam/in-memory-transport.js';
import type { PermissionRule } from '../../src/core/permission/rule-loader.js';
import { AgentRegistryProjection } from '../../src/core/projector/projections/agent-registry.js';

// Phase F.1：夹具 seed——向注册表投影登记白名单 agent（准入测试前置）
function seedRegistryAgent(projStore: ProjectionsStore, agentId: string) {
  const proj = new AgentRegistryProjection();
  proj.initSchema(projStore);
  proj.applyEvent(projStore, {
    seq: 1, timestamp: Date.now(),
    subject: { kind: 'human', userId: 'admin-1' }, family: 'admin', subtype: 'agentRegistered',
    handles: {}, payload: { agentId, role: 'r', capabilities: [], configSource: 'factory', enabled: true },
    value: null,
  } as any);
}

function setup() {
  const eventStore = new EventStore(':memory:');
  const bus = new EventBus(eventStore);
  const projStore = new ProjectionsStore(':memory:');
  seedRegistryAgent(projStore, 'res-01');
  const rules: PermissionRule[] = [];
  const { server, client } = createInMemoryPair();
  const gateway = new SeamGateway(bus, projStore, rules, server, { intervalSec: 30, timeoutSec: 90 });
  gateway.start();
  return { eventStore, bus, projStore, server, client, gateway };
}

describe('SeamGateway 接缝网关', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { ctx.gateway.stop(); ctx.projStore.close(); ctx.eventStore.close(); });

  it('注册经 gateway→落 woken 事件', () => {
    ctx.client.send({
      channel: 'control',
      payload: { type: 'register', agentId: 'res-01', role: 'r', capabilities: [] },
    });
    const schedEvents = ctx.eventStore.getByFamily('schedule');
    expect(schedEvents.find(e => e.subtype === 'woken')).toBeDefined();
  });

  it('事件流经 gateway→落 organ 事件', () => {
    ctx.client.send({
      channel: 'event',
      payload: {
        type: 'emit',
        event: {
          timestamp: Date.now(),
          subject: { kind: 'agent', agentId: 'res-01' },
          family: 'organ', subtype: 'action',
          handles: {}, payload: {}, value: null,
        },
      },
    });
    expect(ctx.eventStore.getByFamily('organ')).toHaveLength(1);
  });

  it('服务调用经 gateway→落 docRead 事件', () => {
    // 需权限规则允许
    const rules: PermissionRule[] = [
      { subject: 'agent:*', action: 'doc:read', object: '*', decision: 'allow' },
    ];
    const eventStore = new EventStore(':memory:');
    const bus = new EventBus(eventStore);
    const projStore = new ProjectionsStore(':memory:');
    seedRegistryAgent(projStore, 'res-01');
    const { server, client } = createInMemoryPair();
    const gateway = new SeamGateway(bus, projStore, rules, server, { intervalSec: 30, timeoutSec: 90 });
    gateway.start();
    client.send({
      channel: 'service',
      payload: { type: 'request', requestId: 'r1', endpoint: 'read', agentId: 'res-01',
        args: { scope: 'memory/global', docId: 'd1', version: 'v1' } },
    });
    expect(eventStore.getByFamily('schedule').find(e => e.subtype === 'docRead')).toBeDefined();
    gateway.stop();
    projStore.close();
    eventStore.close();
  });

  it('控制指令经 gateway→落 piercingIssued 事件', () => {
    ctx.gateway.sendControl('human:u1', 'res-01', 'wake', { taskId: 't1' });
    expect(ctx.eventStore.getByFamily('admin').find(e => e.subtype === 'piercingIssued')).toBeDefined();
  });

  it('Phase F.5：getConnectionRegistry 返回共享注册表（bind 后 resolve 可见）', () => {
    const reg = ctx.gateway.getConnectionRegistry();
    reg.bind('res-01', 'conn-9');
    expect(reg.resolve('res-01')).toBe('conn-9');
  });
});
