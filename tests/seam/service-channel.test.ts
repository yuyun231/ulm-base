import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ServiceChannel, SERVICE_ENDPOINTS } from '../../src/seam/service-channel.js';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { ProjectionsStore } from '../../src/core/projector/projections-store.js';
import { createInMemoryPair } from '../../src/seam/in-memory-transport.js';
import type { PermissionRule } from '../../src/core/permission/rule-loader.js';

function setup() {
  const eventStore = new EventStore(':memory:');
  const bus = new EventBus(eventStore);
  const projStore = new ProjectionsStore(':memory:');
  const rules: PermissionRule[] = [
    { subject: 'agent:*', action: 'doc:read', object: '*', decision: 'allow' },
    { subject: 'agent:*', action: 'task:submitMaterial', object: 'task:*', decision: 'allow' },
    { subject: 'agent:*', action: 'task:reportIssue', object: 'task:*', decision: 'allow' },
  ];
  const { server, client } = createInMemoryPair();
  const channel = new ServiceChannel(bus, projStore, rules, server);
  channel.start();
  return { eventStore, bus, projStore, server, client, channel };
}

describe('ServiceChannel 服务调用通道', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { ctx.channel.stop(); ctx.projStore.close(); ctx.eventStore.close(); });

  it('SERVICE_ENDPOINTS 含7个端点', () => {
    expect(SERVICE_ENDPOINTS).toHaveLength(7);
    expect(SERVICE_ENDPOINTS).toContain('read');
    expect(SERVICE_ENDPOINTS).toContain('consultInitiate');
    expect(SERVICE_ENDPOINTS).toContain('reportIssue');
    expect(SERVICE_ENDPOINTS).toContain('submitMaterial');
    expect(SERVICE_ENDPOINTS).toContain('judgeRequest');
    expect(SERVICE_ENDPOINTS).toContain('dialoguePost');
    expect(SERVICE_ENDPOINTS).toContain('publishTask');
  });

  it('read 端点产 docRead 事件', () => {
    const responses: any[] = [];
    ctx.client.onMessage((msg) => { if ((msg.payload as any).type === 'response') responses.push(msg.payload); });
    ctx.client.send({
      channel: 'service',
      payload: {
        type: 'request', requestId: 'r1', endpoint: 'read',
        agentId: 'res-01', args: { scope: 'memory/global', docId: 'd1', version: 'v1' },
      },
    });
    expect(responses).toHaveLength(1);
    expect(responses[0].requestId).toBe('r1');
    expect(responses[0].ok).toBe(true);
    const schedEvents = ctx.eventStore.getByFamily('schedule');
    expect(schedEvents.find(e => e.subtype === 'docRead')).toBeDefined();
  });

  it('submitMaterial 端点产 nodeSubmitted 事件', () => {
    const responses: any[] = [];
    ctx.client.onMessage((msg) => { if ((msg.payload as any).type === 'response') responses.push(msg.payload); });
    ctx.client.send({
      channel: 'service',
      payload: {
        type: 'request', requestId: 'r2', endpoint: 'submitMaterial',
        agentId: 'res-01', args: { taskId: 't1', nodeId: 'n1', material: 'done', isLastNode: true },
      },
    });
    expect(responses[0].ok).toBe(true);
    const taskEvents = ctx.eventStore.getByFamily('task');
    expect(taskEvents.find(e => e.subtype === 'nodeSubmitted')).toBeDefined();
  });

  it('未知端点返回错误（封闭集合）', () => {
    const responses: any[] = [];
    ctx.client.onMessage((msg) => { if ((msg.payload as any).type === 'response') responses.push(msg.payload); });
    ctx.client.send({
      channel: 'service',
      payload: {
        type: 'request', requestId: 'r3', endpoint: 'admin_setParam',
        agentId: 'res-01', args: { key: 'x', value: 1 },
      },
    });
    expect(responses[0].ok).toBe(false);
    expect(responses[0].error).toContain('未知端点');
  });

  it('无 admin 端点——结构性无入口（6.7）', () => {
    expect(SERVICE_ENDPOINTS.find(e => e.startsWith('admin') || e.startsWith('setParam'))).toBeUndefined();
  });
});
