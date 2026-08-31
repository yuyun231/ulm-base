import type { EventBus } from '../../core/event-bus/bus.js';
import type { PermissionRule } from '../../core/permission/rule-loader.js';
import { checkPermission } from '../../core/permission/check.js';
import type { EventEnvelope } from '../../core/event-bus/envelope.js';

function parseSubject(s: string): EventEnvelope['subject'] {
  const [kind, id] = s.split(':');
  if (kind === 'human') return { kind: 'human', userId: id };
  if (kind === 'agent') return { kind: 'agent', agentId: id };
  return { kind: 'module', module: id };
}

// 设计锚点 6.5a：权限规则表管理（三级粒度：聚合任务→子任务→agent）
export class PermissionCommands {
  private bus: EventBus;
  private rules: PermissionRule[];
  constructor(bus: EventBus, rules: PermissionRule[]) { this.bus = bus; this.rules = rules; }

  setPermissionRule(subject: string, rule: PermissionRule & { ruleId?: string }) {
    const perm = checkPermission(this.rules, subject, 'admin:setPermission', `rule:${rule.subject}`);
    if (perm.decision === 'deny') throw new Error(`权限拒绝`);
    // Phase F.2 修复：载荷平铺为投影消费形状 {ruleId, subject, action, object, effect}，
    // 门禁轨入参用 decision，事件载荷统一用 effect（投影轨字段名）
    const ruleId = rule.ruleId ?? `perm-${rule.subject}-${rule.action}`.replace(/[:*]/g, '_');
    return this.bus.publish({
      seq: null, timestamp: Date.now(), subject: parseSubject(subject),
      family: 'admin', subtype: 'permissionChanged', handles: {},
      payload: { ruleId, subject: rule.subject, action: rule.action, object: rule.object, effect: rule.decision },
      value: null,
    });
  }

  // Phase F.5（决策点 1）：删除权限规则——事件只带 ruleId，投影 DELETE。
  // 动作沿用 admin:setPermission（决策点 3甲：权限增删同动作，object 携带 ruleId 前缀）
  removePermissionRule(subject: string, ruleId: string) {
    const perm = checkPermission(this.rules, subject, 'admin:setPermission', `rule:${ruleId}`);
    if (perm.decision === 'deny') throw new Error(`权限拒绝`);
    return this.bus.publish({
      seq: null, timestamp: Date.now(), subject: parseSubject(subject),
      family: 'admin', subtype: 'permissionRemoved', handles: {},
      payload: { ruleId },
      value: null,
    });
  }
}
