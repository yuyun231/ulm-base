import { describe, it, expect } from 'vitest';
import { importFactoryAgents } from '../../src/bootstrap/factory-import.js';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { ProjectionsStore } from '../../src/core/projector/projections-store.js';
import { AgentRegistryProjection } from '../../src/core/projector/projections/agent-registry.js';
import { ProjectionRunner } from '../../src/core/projector/runner.js';

function makeCtx() {
  const eventStore = new EventStore(':memory:');
  const bus = new EventBus(eventStore);
  const projStore = new ProjectionsStore(':memory:');
  const runner = new ProjectionRunner(bus, eventStore, projStore, [new AgentRegistryProjection()]);
  runner.start();
  return { eventStore, bus, projStore, runner, stop() { runner.stop(); projStore.close(); eventStore.close(); } };
}

const THREE = [
  { agentId: 'task-admin', role: 'task-admin', description: '任务管理员', capabilities: ['task:judge'], spawnPolicy: 'spawn' as const },
  { agentId: 'historian', role: 'historian', description: '史官', capabilities: ['stream:read'], spawnPolicy: 'spawn' as const },
  { agentId: 'plan-assistant', role: 'plan-assistant', description: '方案助手', capabilities: ['dialogue:respond'], spawnPolicy: 'spawn' as const },
];

describe('importFactoryAgents（Phase F.2 D8 补缺不覆盖）', () => {
  it('首次导入：3 内置 agent 全部落行（configSource=factory）', () => {
    const ctx = makeCtx();
    importFactoryAgents(ctx.bus, ctx.projStore, THREE);
    const rows = ctx.projStore.all('SELECT * FROM agent_registry ORDER BY agentId ASC') as any[];
    expect(rows.map(r => r.agentId)).toEqual(['historian', 'plan-assistant', 'task-admin']);
    expect(rows.every(r => r.configSource === 'factory')).toBe(true);
    expect(rows.every(r => r.spawnPolicy === 'spawn')).toBe(true);
    ctx.stop();
  });

  it('重复导入幂等：仍 3 行（agentUpdated UPSERT 不增行）', () => {
    const ctx = makeCtx();
    importFactoryAgents(ctx.bus, ctx.projStore, THREE);
    importFactoryAgents(ctx.bus, ctx.projStore, THREE);
    expect(ctx.projStore.all('SELECT * FROM agent_registry')).toHaveLength(3);
    ctx.stop();
  });

  it('D8：同名 configSource=panel 的行跳过不覆盖', () => {
    const ctx = makeCtx();
    ctx.bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'u1' }, family: 'admin', subtype: 'agentRegistered',
      handles: {}, payload: { agentId: 'task-admin', role: 'my-custom-role', description: '面板定制', capabilities: ['x'], spawnPolicy: 'external', configSource: 'panel' },
      value: null,
    });
    importFactoryAgents(ctx.bus, ctx.projStore, THREE);
    const row = ctx.projStore.get("SELECT * FROM agent_registry WHERE agentId = 'task-admin'") as any;
    expect(row.role).toBe('my-custom-role');
    expect(row.configSource).toBe('panel');
    expect(JSON.parse(row.capabilities)).toEqual(['x']);
    expect(ctx.projStore.get("SELECT * FROM agent_registry WHERE agentId = 'historian'")).toBeDefined();
    ctx.stop();
  });

  it('agent_registry 表不存在时视为全空（容忍未建库调用方）', () => {
    const eventStore = new EventStore(':memory:');
    const bus = new EventBus(eventStore);
    const projStore = new ProjectionsStore(':memory:');
    expect(() => importFactoryAgents(bus, projStore, THREE)).not.toThrow();
    eventStore.close(); projStore.close();
  });
});
