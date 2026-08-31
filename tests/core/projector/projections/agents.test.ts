import { describe, it, expect, beforeEach } from 'vitest';
import { ProjectionsStore } from '../../../src/core/projector/projections-store.js';
import { AgentsProjection } from '../../../src/core/projector/projections/agents.js';
import type { StoredEventEnvelope } from '../../../src/core/event-bus/envelope.js';

function makeSchedEvent(seq: number, subtype: string, agentId: string, payload: object = {}): StoredEventEnvelope {
  return { seq, timestamp: Date.now(), subject: { kind: 'agent', agentId }, family: 'schedule', subtype, handles: {}, payload, value: null } as StoredEventEnvelope;
}

describe('AgentsProjection agent投影', () => {
  let projStore: ProjectionsStore;
  let proj: AgentsProjection;

  beforeEach(() => {
    projStore = new ProjectionsStore(':memory:');
    proj = new AgentsProjection();
    proj.initSchema(projStore);
  });

  it('woken 事件：休眠→唤醒空闲', () => {
    proj.applyEvent(projStore, makeSchedEvent(1, 'woken', 'res-01'));
    const agent = projStore.get('SELECT * FROM agents WHERE agentId = ?', 'res-01') as any;
    expect(agent.wakeState).toBe('awakened');
    expect(agent.workState).toBe('idle');
  });

  it('loaded 事件：唤醒空闲→工作', () => {
    proj.applyEvent(projStore, makeSchedEvent(1, 'woken', 'res-01'));
    proj.applyEvent(projStore, makeSchedEvent(2, 'loaded', 'res-01'));
    const agent = projStore.get('SELECT * FROM agents WHERE agentId = ?', 'res-01') as any;
    expect(agent.workState).toBe('working');
  });

  it('slept 事件：唤醒→休眠（workState 清空）', () => {
    proj.applyEvent(projStore, makeSchedEvent(1, 'woken', 'res-01'));
    proj.applyEvent(projStore, makeSchedEvent(2, 'loaded', 'res-01'));
    proj.applyEvent(projStore, makeSchedEvent(3, 'slept', 'res-01'));
    const agent = projStore.get('SELECT * FROM agents WHERE agentId = ?', 'res-01') as any;
    expect(agent.wakeState).toBe('dormant');
    expect(agent.workState).toBeNull();
  });

  it('focusBound 事件设置 focusBinding', () => {
    proj.applyEvent(projStore, makeSchedEvent(1, 'woken', 'res-01'));
    proj.applyEvent(projStore, makeSchedEvent(2, 'focusBound', 'res-01', { aggregateTaskId: 'agg-1' }));
    const agent = projStore.get('SELECT * FROM agents WHERE agentId = ?', 'res-01') as any;
    expect(agent.focusBinding).toBe('agg-1');
  });

  it('focusBound 事件解绑（aggregateTaskId 为 null）', () => {
    proj.applyEvent(projStore, makeSchedEvent(1, 'woken', 'res-01'));
    proj.applyEvent(projStore, makeSchedEvent(2, 'focusBound', 'res-01', { aggregateTaskId: 'agg-1' }));
    proj.applyEvent(projStore, makeSchedEvent(3, 'focusBound', 'res-01', { aggregateTaskId: null }));
    const agent = projStore.get('SELECT * FROM agents WHERE agentId = ?', 'res-01') as any;
    expect(agent.focusBinding).toBeNull();
  });

  it('docRead 事件更新 lastActivityAt', () => {
    proj.applyEvent(projStore, makeSchedEvent(1, 'woken', 'res-01'));
    proj.applyEvent(projStore, makeSchedEvent(2, 'docRead', 'res-01'));
    const agent = projStore.get('SELECT * FROM agents WHERE agentId = ?', 'res-01') as any;
    expect(agent.lastActivityAt).toBeGreaterThan(0);
  });

  it('agentLost 事件标记失联', () => {
    proj.applyEvent(projStore, makeSchedEvent(1, 'woken', 'res-01'));
    proj.applyEvent(projStore, makeSchedEvent(2, 'agentLost', 'res-01'));
    const agent = projStore.get('SELECT * FROM agents WHERE agentId = ?', 'res-01') as any;
    expect(agent.lost).toBe(1);
  });
});
