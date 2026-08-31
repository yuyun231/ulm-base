import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { InMemoryServer } from '../../src/seam/in-memory-transport.js';
import { ConnectionRegistry } from '../../src/seam/connection-registry.js';
import { SeamGateway } from '../../src/seam/gateway.js';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { ProjectionsStore } from '../../src/core/projector/projections-store.js';
import { AgentRegistryProjection } from '../../src/core/projector/projections/agent-registry.js';
import type { PermissionRule } from '../../src/core/permission/rule-loader.js';

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

// E.1 补完：接缝多连接（8.1 多内核各自一条）+ 连接注册表
// 三层：transport 多客户端 → registry 绑定 → gateway 级定向路由

describe('InMemoryServer 多客户端', () => {
  it('两个客户端 connect，sendTo 定向只到目标', () => {
    const server = new InMemoryServer();
    const c1 = server.connect();
    const c2 = server.connect();
    const got1: any[] = [];
    const got2: any[] = [];
    c1.onMessage(m => got1.push(m));
    c2.onMessage(m => got2.push(m));
    server.sendTo(c1.connId, { channel: 'control', payload: { n: 1 } });
    expect(got1).toHaveLength(1);
    expect(got2).toHaveLength(0);
  });

  it('send 广播到全部客户端', () => {
    const server = new InMemoryServer();
    const c1 = server.connect();
    const c2 = server.connect();
    const got1: any[] = [];
    const got2: any[] = [];
    c1.onMessage(m => got1.push(m));
    c2.onMessage(m => got2.push(m));
    server.send({ channel: 'control', payload: { n: 1 } });
    expect(got1).toHaveLength(1);
    expect(got2).toHaveLength(1);
  });

  it('客户端 close 触发 server onDisconnect', () => {
    const server = new InMemoryServer();
    const c1 = server.connect();
    const disconnected: string[] = [];
    server.onDisconnect(id => disconnected.push(id));
    c1.close();
    expect(disconnected).toEqual([c1.connId]);
  });

  it('客户端 close 后 server 广播不再送达该客户端', () => {
    const server = new InMemoryServer();
    const c1 = server.connect();
    const got: any[] = [];
    c1.onMessage(m => got.push(m));
    c1.close();
    server.send({ channel: 'control', payload: {} });
    expect(got).toHaveLength(0);
  });
});

describe('ConnectionRegistry 连接注册表', () => {
  it('bind/resolve 双向映射', () => {
    const reg = new ConnectionRegistry();
    reg.bind('a1', 'conn-1');
    expect(reg.resolve('a1')).toBe('conn-1');
    expect(reg.agentOf('conn-1')).toBe('a1');
  });

  it('同 agentId 重复 register：覆盖旧绑定（决策3：不做通知）', () => {
    const reg = new ConnectionRegistry();
    reg.bind('a1', 'conn-1');
    reg.bind('a1', 'conn-2');
    expect(reg.resolve('a1')).toBe('conn-2');
    expect(reg.agentOf('conn-1')).toBeNull();
    expect(reg.agentOf('conn-2')).toBe('a1');
  });

  it('unbindByConn 清理双向映射', () => {
    const reg = new ConnectionRegistry();
    reg.bind('a1', 'conn-1');
    reg.unbindByConn('conn-1');
    expect(reg.resolve('a1')).toBeNull();
    expect(reg.agentOf('conn-1')).toBeNull();
  });
});

describe('多连接端到端（gateway 级）', () => {
  const rules: PermissionRule[] = [
    { subject: 'agent:*', action: 'doc:read', object: '*', decision: 'allow' },
  ];
  let eventStore: EventStore;
  let projStore: ProjectionsStore;
  let gateway: SeamGateway;
  let server: InMemoryServer;
  let a: any;
  let b: any;

  afterEach(() => {
    gateway.stop();
    projStore.close();
    eventStore.close();
  });

  function setup() {
    eventStore = new EventStore(':memory:');
    const bus = new EventBus(eventStore);
    projStore = new ProjectionsStore(':memory:');
    seedRegistryAgent(projStore, 'agent-a');
    seedRegistryAgent(projStore, 'agent-b');
    server = new InMemoryServer();
    gateway = new SeamGateway(bus, projStore, rules, server, { intervalSec: 30, timeoutSec: 90 });
    gateway.start();
    a = server.connect();
    b = server.connect();
  }

  it('两个 agent 注册后，wake 指令定向只到目标 agent', () => {
    setup();
    a.send({ channel: 'control', payload: { type: 'register', agentId: 'agent-a', role: 'r', capabilities: [] } });
    b.send({ channel: 'control', payload: { type: 'register', agentId: 'agent-b', role: 'r', capabilities: [] } });
    const gotA: any[] = [];
    const gotB: any[] = [];
    a.onMessage((m: any) => { if (m.channel === 'control') gotA.push(m.payload); });
    b.onMessage((m: any) => { if (m.channel === 'control') gotB.push(m.payload); });
    gateway.sendControl('human:u1', 'agent-a', 'wake', { taskId: 't1' });
    const wakeA = gotA.find(p => p.type === 'command' && p.command === 'wake');
    expect(wakeA).toBeDefined();
    expect((wakeA as any).taskId).toBe('t1');
    expect(gotB.find(p => p.type === 'command')).toBeUndefined();
  });

  it('未注册 agent 的指令：不投递 + 合成失败回执 piercingAcked（决策2）', () => {
    setup();
    const gotA: any[] = [];
    a.onMessage((m: any) => { if (m.channel === 'control') gotA.push(m.payload); });
    gateway.sendControl('human:u1', 'agent-ghost', 'wake', {});
    expect(gotA).toHaveLength(0);
    const acked = eventStore.getByFamily('admin').find(e => e.subtype === 'piercingAcked') as any;
    expect(acked).toBeDefined();
    expect(acked.payload.success).toBe(false);
    expect(acked.payload.agentId).toBe('agent-ghost');
  });

  it('service 回复只回给请求方连接', () => {
    setup();
    a.send({ channel: 'control', payload: { type: 'register', agentId: 'agent-a', role: 'r', capabilities: [] } });
    const respA: any[] = [];
    const respB: any[] = [];
    a.onMessage((m: any) => { if (m.channel === 'service') respA.push(m.payload); });
    b.onMessage((m: any) => { if (m.channel === 'service') respB.push(m.payload); });
    a.send({
      channel: 'service',
      payload: { type: 'request', requestId: 'r1', endpoint: 'read', agentId: 'agent-a',
        args: { scope: 'memory/global', docId: 'd1', version: 'v1' } },
    });
    expect(respA).toHaveLength(1);
    expect((respA[0] as any).type).toBe('response');
    expect(respB).toHaveLength(0);
  });

  it('事件 ack 只回给上报方连接', () => {
    setup();
    const ackA: any[] = [];
    const ackB: any[] = [];
    a.onMessage((m: any) => { if (m.channel === 'event') ackA.push(m.payload); });
    b.onMessage((m: any) => { if (m.channel === 'event') ackB.push(m.payload); });
    a.send({
      channel: 'event',
      payload: {
        type: 'emit',
        event: {
          timestamp: Date.now(),
          subject: { kind: 'agent', agentId: 'agent-a' },
          family: 'organ', subtype: 'action',
          handles: {}, payload: {}, value: null,
        },
      },
    });
    expect(ackA).toHaveLength(1);
    expect(ackB).toHaveLength(0);
  });

  it('客户端断连后 registry 解绑，指令转为失败回执', () => {
    setup();
    a.send({ channel: 'control', payload: { type: 'register', agentId: 'agent-a', role: 'r', capabilities: [] } });
    a.close(); // 断连 → onDisconnect → unbindByConn
    const gotB: any[] = [];
    b.onMessage((m: any) => { if (m.channel === 'control') gotB.push(m.payload); });
    gateway.sendControl('human:u1', 'agent-a', 'wake', {});
    // 不广播误投给其他连接
    expect(gotB).toHaveLength(0);
    const acked = eventStore.getByFamily('admin').find(e => e.subtype === 'piercingAcked') as any;
    expect(acked).toBeDefined();
    expect(acked.payload.success).toBe(false);
  });
});

describe('WsTransportServer 多连接定向', () => {
  it('两个 ws 客户端连接，sendTo 只到 conn-1', { timeout: 5000 }, async () => {
    const server = new (await import('../../src/seam/ws-transport.js')).WsTransportServer(9881);
    const open = (url: string) => new Promise<WebSocket>((res, rej) => {
      const ws = new WebSocket(url);
      ws.on('open', () => res(ws));
      ws.on('error', rej);
    });
    const c1 = await open('ws://localhost:9881');
    const c2 = await open('ws://localhost:9881');
    const got1: any[] = [];
    const got2: any[] = [];
    c1.on('message', d => got1.push(JSON.parse(d.toString())));
    c2.on('message', d => got2.push(JSON.parse(d.toString())));
    await new Promise(r => setTimeout(r, 100)); // 等 server 侧登记连接
    server.sendTo('conn-1', { channel: 'control', payload: { n: 1 } });
    await new Promise(r => setTimeout(r, 100));
    expect(got1).toHaveLength(1);
    expect(got2).toHaveLength(0);
    c1.close();
    c2.close();
    server.close();
  });
});
