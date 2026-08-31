import { describe, it, expect } from 'vitest';
import { checkPermission, type PermissionRule } from '../../src/core/permission/check.js';

const rules: PermissionRule[] = [
  { subject: 'human:*', action: 'task:create', object: '*', decision: 'allow' },
  { subject: 'agent:res-01', action: 'task:reportIssue', object: 'task:t1', decision: 'allow' },
  { subject: 'agent:*', action: 'admin:*', object: '*', decision: 'deny' },
  { subject: 'human:*', action: 'task:approve', object: 'task:*', decision: 'require-approval' },
];

describe('checkPermission 权限校验', () => {
  it('精确匹配 allow', () => {
    const result = checkPermission(rules, 'human:u1', 'task:create', 'task:t1');
    expect(result.decision).toBe('allow');
  });

  it('通配符匹配 human:* + object:*', () => {
    const result = checkPermission(rules, 'human:u1', 'task:create', 'anything');
    expect(result.decision).toBe('allow');
  });

  it('agent 通配 deny admin 动作', () => {
    const result = checkPermission(rules, 'agent:res-02', 'admin:setParam', 'module:scheduler');
    expect(result.decision).toBe('deny');
  });

  it('require-approval 返回需审批', () => {
    const result = checkPermission(rules, 'human:u1', 'task:approve', 'task:t1');
    expect(result.decision).toBe('require-approval');
  });

  it('无匹配规则默认 deny（最小权限原则）', () => {
    const result = checkPermission(rules, 'agent:res-01', 'task:create', 'task:t1');
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('无匹配');
  });

  it('精确规则优先于通配规则', () => {
    const specificRules: PermissionRule[] = [
      { subject: 'agent:*', action: 'task:reportIssue', object: '*', decision: 'deny' },
      { subject: 'agent:res-01', action: 'task:reportIssue', object: 'task:t1', decision: 'allow' },
    ];
    const result = checkPermission(specificRules, 'agent:res-01', 'task:reportIssue', 'task:t1');
    expect(result.decision).toBe('allow');
  });
});
