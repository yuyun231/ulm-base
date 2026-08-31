import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProjectionsStore } from '../../../src/core/projector/projections-store.js';
import { AgentRegistryProjection } from '../../../src/core/projector/projections/agent-registry.js';
import type { StoredEventEnvelope } from '../../../src/core/event-bus/envelope.js';

function makeAdminEvent(seq: number, subtype: string, payload: object): StoredEventEnvelope {
  return {
    seq, timestamp: Date.now(),
    subject: { kind: 'human', userId: 'admin-1' },
    family: 'admin', subtype, handles: {}, payload, value: null,
  } as StoredEventEnvelope;
}

describe('AgentRegistryProjection（Phase F.1 注册表持久化）', () => {
  let projStore: ProjectionsStore;
  let proj: AgentRegistryProjection;

  beforeEach(() => {
    projStore = new ProjectionsStore(':memory:');
    proj = new AgentRegistryProjection();
    proj.initSchema(projStore);
  });
  afterEach(() => { projStore.close(); });

  it('initSchema 建表', () => {
    const tables = projStore.all("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_registry'") as any[];
    expect(tables).toHaveLength(1);
  });

  it('agentRegistered → 落行（身份字段/默认值）', () => {
    proj.applyEvent(projStore, makeAdminEvent(1, 'agentRegistered', {
      agentId: 'task-admin', role: 'task-admin', description: '任务管理员',
      capabilities: ['task:judge', 'task:publishChild'], spawnPolicy: 'spawn', configSource: 'factory',
    }));
    const row = projStore.get('SELECT * FROM agent_registry WHERE agentId = ?', 'task-admin') as any;
    expect(row).toBeDefined();
    expect(row.role).toBe('task-admin');
    expect(row.description).toBe('任务管理员');
    expect(row.capabilities).toBe('["task:judge","task:publishChild"]');
    expect(row.spawnPolicy).toBe('spawn');
    expect(row.configSource).toBe('factory');
    expect(row.enabled).toBe(1);
    expect(row.createdAt).toBeGreaterThan(0);
  });

  it('agentUpdated → UPSERT 覆盖（updatedAt 更新）', () => {
    proj.applyEvent(projStore, makeAdminEvent(1, 'agentRegistered', {
      agentId: 'a1', role: 'r1', description: 'd1', capabilities: [], spawnPolicy: 'external', configSource: 'panel',
    }));
    proj.applyEvent(projStore, makeAdminEvent(2, 'agentUpdated', {
      agentId: 'a1', role: 'r2', description: 'd2', capabilities: ['x'], spawnPolicy: 'spawn', configSource: 'panel',
    }));
    const rows = projStore.all('SELECT * FROM agent_registry') as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('r2');
    expect(rows[0].spawnPolicy).toBe('spawn');
    expect(rows[0].updatedAt).toBeGreaterThanOrEqual(rows[0].createdAt);
  });

  it('agentRemoved → 删除行', () => {
    proj.applyEvent(projStore, makeAdminEvent(1, 'agentRegistered', {
      agentId: 'a1', role: 'r1', configSource: 'panel',
    }));
    proj.applyEvent(projStore, makeAdminEvent(2, 'agentRemoved', { agentId: 'a1' }));
    const row = projStore.get('SELECT * FROM agent_registry WHERE agentId = ?', 'a1') as any;
    expect(row).toBeUndefined();
  });

  it('enabled=0 行可由 agentUpdated 置回（disable/enable 语义）', () => {
    proj.applyEvent(projStore, makeAdminEvent(1, 'agentRegistered', {
      agentId: 'a1', role: 'r1', configSource: 'panel', enabled: true,
    }));
    proj.applyEvent(projStore, makeAdminEvent(2, 'agentUpdated', {
      agentId: 'a1', role: 'r1', configSource: 'panel', enabled: false,
    }));
    const row = projStore.get('SELECT * FROM agent_registry WHERE agentId = ?', 'a1') as any;
    expect(row.enabled).toBe(0);
  });

  it('非 admin 族/非注册子类型事件不处理', () => {
    proj.applyEvent(projStore, makeAdminEvent(1, 'permissionChanged', { ruleId: 'x', subject: 'a', action: 'b', effect: 'allow' }));
    expect(projStore.all('SELECT * FROM agent_registry')).toHaveLength(0);
  });
});
