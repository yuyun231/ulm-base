import { describe, it, expect, beforeEach } from 'vitest';
import { ProjectionsStore } from '../../../src/core/projector/projections-store.js';
import { RegistryProjection } from '../../../src/core/projector/projections/registry.js';
import type { StoredEventEnvelope } from '../../../src/core/event-bus/envelope.js';

function makeEvent(): StoredEventEnvelope {
  return { seq: 1, timestamp: Date.now(), subject: { kind: 'agent', agentId: 'res-01' }, family: 'admin', subtype: 'paramChanged', handles: {}, payload: {}, value: null } as StoredEventEnvelope;
}

describe('RegistryProjection 注册表投影（占位）', () => {
  let projStore: ProjectionsStore;
  let proj: RegistryProjection;

  beforeEach(() => {
    projStore = new ProjectionsStore(':memory:');
    proj = new RegistryProjection();
    proj.initSchema(projStore);
  });

  it('initSchema 建表', () => {
    const tables = projStore.all("SELECT name FROM sqlite_master WHERE type='table' AND name='registry'") as any[];
    expect(tables).toHaveLength(1);
  });

  it('applyEvent 不抛异常（占位空实现）', () => {
    expect(() => proj.applyEvent(projStore, makeEvent())).not.toThrow();
  });
});
