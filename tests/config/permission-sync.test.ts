import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { EventStore } from '../../src/core/event-bus/store.js';
import { wirePermissionSync } from '../../src/config/permission-sync.js';
import { GitAsset } from '../../src/core/git-asset.js';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PermissionRule } from '../../src/core/permission/rule-loader.js';

describe('wirePermissionSync 权限热改同步（决策点 2）', () => {
  let dir: string;
  let eventStore: EventStore;
  let bus: EventBus;
  let rules: PermissionRule[];
  let unwire: () => void;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ulm-permsync-'));
    new GitAsset(dir).initRepo();
    eventStore = new EventStore(':memory:');
    bus = new EventBus(eventStore);
    rules = [{ ruleId: 'g1', subject: 'human:*', action: '*', object: '*', decision: 'allow' }];
    unwire = wirePermissionSync(bus, rules, new GitAsset(dir));
  });

  afterEach(() => {
    unwire();
    eventStore.close();
    try { rmSync(dir, { recursive: true }); } catch { /* 清理失败忽略 */ }
  });

  function publish(subtype: string, subject: any, payload: object): void {
    bus.publish({
      seq: null, timestamp: Date.now(), subject,
      family: 'admin', subtype, handles: {}, payload, value: null,
    });
  }

  it('permissionChanged（human 主体）：热改数组 + 落盘（ruleId 不落盘）', () => {
    publish('permissionChanged', { kind: 'human', userId: 'u1' }, {
      ruleId: 'r2', subject: 'agent:res-01', action: 'doc:read', object: '*', effect: 'allow',
    });
    expect(rules.length).toBe(2);
    expect(rules[1]).toEqual({ ruleId: 'r2', subject: 'agent:res-01', action: 'doc:read', object: '*', decision: 'allow' });
    const text = readFileSync(join(dir, 'permission-rules.yaml'), 'utf-8');
    expect(text).toContain('res-01');
    expect(text).not.toContain('ruleId');
  });

  it('同 ruleId UPSERT 覆盖（effect→decision 映射）', () => {
    publish('permissionChanged', { kind: 'human', userId: 'u1' }, {
      ruleId: 'r2', subject: 'agent:res-01', action: 'doc:read', object: '*', effect: 'allow',
    });
    publish('permissionChanged', { kind: 'human', userId: 'u1' }, {
      ruleId: 'r2', subject: 'agent:res-01', action: 'doc:read', object: '*', effect: 'deny',
    });
    expect(rules.length).toBe(2);
    expect(rules[1].decision).toBe('deny');
  });

  it('permissionRemoved（human 主体）：删数组 + 落盘', () => {
    publish('permissionChanged', { kind: 'human', userId: 'u1' }, {
      ruleId: 'r2', subject: 'agent:res-01', action: 'doc:read', object: '*', effect: 'allow',
    });
    publish('permissionRemoved', { kind: 'human', userId: 'u1' }, { ruleId: 'r2' });
    expect(rules.length).toBe(1);
    const text = readFileSync(join(dir, 'permission-rules.yaml'), 'utf-8');
    expect(text).not.toContain('res-01');
  });

  it('module:system（出厂导入）不热改不落盘', () => {
    publish('permissionChanged', { kind: 'module', module: 'system' }, {
      ruleId: 'r9', subject: 'agent:res-01', action: 'doc:read', object: '*', effect: 'allow',
    });
    expect(rules.length).toBe(1);
    expect(existsSync(join(dir, 'permission-rules.yaml'))).toBe(false);
  });

  it('删除不存在的 ruleId：无异常不落盘', () => {
    publish('permissionRemoved', { kind: 'human', userId: 'u1' }, { ruleId: 'ghost' });
    expect(rules.length).toBe(1);
    expect(existsSync(join(dir, 'permission-rules.yaml'))).toBe(false);
  });
});
