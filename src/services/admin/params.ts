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

// 设计锚点 6.7：管理模块命令面仅对人开放——agent 侧权限全部 deny，结构性无入口
export class AdminCommands {
  private bus: EventBus;
  private rules: PermissionRule[];
  constructor(bus: EventBus, rules: PermissionRule[]) { this.bus = bus; this.rules = rules; }

  // 3.7 参数热改
  setParam(subject: string, key: string, value: any) {
    const perm = checkPermission(this.rules, subject, 'admin:setParam', `param:${key}`);
    if (perm.decision === 'deny') throw new Error(`权限拒绝：${subject} 不可改参数`);
    return this.bus.publish({
      seq: null, timestamp: Date.now(), subject: parseSubject(subject),
      family: 'admin', subtype: 'paramChanged', handles: {}, payload: { key, value }, value: null,
    });
  }

  // 6.2#4/#6 强制操作
  forceWake(subject: string, agentId: string) {
    const perm = checkPermission(this.rules, subject, 'admin:forceWake', `agent:${agentId}`);
    if (perm.decision === 'deny') throw new Error(`权限拒绝`);
    return this.bus.publish({
      seq: null, timestamp: Date.now(), subject: parseSubject(subject),
      family: 'admin', subtype: 'forceCommanded', handles: {}, payload: { action: 'forceWake', agentId }, value: null,
    });
  }

  forceSleep(subject: string, agentId: string) {
    const perm = checkPermission(this.rules, subject, 'admin:forceSleep', `agent:${agentId}`);
    if (perm.decision === 'deny') throw new Error(`权限拒绝`);
    return this.bus.publish({
      seq: null, timestamp: Date.now(), subject: parseSubject(subject),
      family: 'admin', subtype: 'forceCommanded', handles: {}, payload: { action: 'forceSleep', agentId }, value: null,
    });
  }

  // 6.2#9 全自动化
  toggleFullAutomation(subject: string, enabled: boolean) {
    const perm = checkPermission(this.rules, subject, 'admin:toggleFullAuto', `automation`);
    if (perm.decision === 'deny') throw new Error(`权限拒绝`);
    return this.bus.publish({
      seq: null, timestamp: Date.now(), subject: parseSubject(subject),
      family: 'admin', subtype: 'fullAutoToggled', handles: {}, payload: { enabled }, value: null,
    });
  }

  // 6.2#8 并发上限
  setConcurrencyLimit(subject: string, limit: number) {
    const perm = checkPermission(this.rules, subject, 'admin:setParam', `param:scheduler.maxWorkingAgents`);
    if (perm.decision === 'deny') throw new Error(`权限拒绝`);
    return this.bus.publish({
      seq: null, timestamp: Date.now(), subject: parseSubject(subject),
      family: 'admin', subtype: 'paramChanged', handles: {}, payload: { key: 'scheduler.maxWorkingAgents', value: limit }, value: null,
    });
  }

  // 6.2#7 历史记录开关
  toggleHistorianReport(subject: string, enabled: boolean) {
    const perm = checkPermission(this.rules, subject, 'admin:setParam', `param:historian.reportEnabled`);
    if (perm.decision === 'deny') throw new Error(`权限拒绝`);
    return this.bus.publish({
      seq: null, timestamp: Date.now(), subject: parseSubject(subject),
      family: 'admin', subtype: 'paramChanged', handles: {}, payload: { key: 'historian.reportEnabled', value: enabled }, value: null,
    });
  }

  // 6.2#11 判定者配置
  setJudgeConfig(subject: string, config: any) {
    const perm = checkPermission(this.rules, subject, 'admin:setJudgeConfig', `judge`);
    if (perm.decision === 'deny') throw new Error(`权限拒绝`);
    return this.bus.publish({
      seq: null, timestamp: Date.now(), subject: parseSubject(subject),
      family: 'admin', subtype: 'judgeConfigChanged', handles: {}, payload: { config }, value: null,
    });
  }
}
