import { describe, it, expect, beforeEach } from 'vitest';
import { ProjectionsStore } from '../../../src/core/projector/projections-store.js';
import { PermissionRulesProjection } from '../../../src/core/projector/projections/permission-rules.js';
import type { StoredEventEnvelope } from '../../../src/core/event-bus/envelope.js';

function makeAdminEvent(seq: number, handles: object = {}, payload: object = {}): StoredEventEnvelope {
  return { seq, timestamp: Date.now(), subject: { kind: 'human', userId: 'admin-1' }, family: 'admin', subtype: 'permissionChanged', handles, payload, value: null } as StoredEventEnvelope;
}

describe('PermissionRulesProjection 权限规则投影', () => {
  let projStore: ProjectionsStore;
  let proj: PermissionRulesProjection;

  beforeEach(() => {
    projStore = new ProjectionsStore(':memory:');
    proj = new PermissionRulesProjection();
    proj.initSchema(projStore);
  });

  it('permissionChanged 事件物化规则', () => {
    proj.applyEvent(projStore, makeAdminEvent(1, {}, {
      ruleId: 'rule-1', subject: 'agent:res-01', action: 'task.create', effect: 'allow',
    } as any));
    const rule = projStore.get('SELECT * FROM permission_rules WHERE ruleId = ?', 'rule-1') as any;
    expect(rule).toBeDefined();
    expect(rule.subject).toBe('agent:res-01');
    expect(rule.action).toBe('task.create');
    expect(rule.effect).toBe('allow');
  });

  it('重复 ruleId 覆盖（UPSERT）', () => {
    proj.applyEvent(projStore, makeAdminEvent(1, {}, {
      ruleId: 'rule-1', subject: 'agent:res-01', action: 'task.create', effect: 'allow',
    } as any));
    proj.applyEvent(projStore, makeAdminEvent(2, {}, {
      ruleId: 'rule-1', subject: 'agent:res-01', action: 'task.create', effect: 'deny',
    } as any));
    const rule = projStore.get('SELECT * FROM permission_rules WHERE ruleId = ?', 'rule-1') as any;
    expect(rule.effect).toBe('deny');
  });

  it('非管理族事件不处理', () => {
    proj.applyEvent(projStore, { ...makeAdminEvent(1, {}, { ruleId: 'rule-1' } as any), family: 'task', subtype: 'created' } as any);
    expect(projStore.all('SELECT * FROM permission_rules')).toHaveLength(0);
  });

  it('Phase F.5：permissionRemoved 事件删除规则', () => {
    proj.applyEvent(projStore, makeAdminEvent(1, {}, {
      ruleId: 'rule-1', subject: 'agent:res-01', action: 'task.create', effect: 'allow',
    } as any));
    proj.applyEvent(projStore, { ...makeAdminEvent(2), subtype: 'permissionRemoved', payload: { ruleId: 'rule-1' } } as any);
    expect(projStore.get('SELECT * FROM permission_rules WHERE ruleId = ?', 'rule-1')).toBeUndefined();
  });

  it('Phase F.5：删除不存在的 ruleId 静默无副作用', () => {
    proj.applyEvent(projStore, { ...makeAdminEvent(1), subtype: 'permissionRemoved', payload: { ruleId: 'ghost' } } as any);
    expect(projStore.all('SELECT * FROM permission_rules').length).toBe(0);
  });
});
