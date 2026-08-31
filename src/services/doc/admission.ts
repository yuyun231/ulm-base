import type { EventBus } from '../../core/event-bus/bus.js';
import type { PermissionRule } from '../../core/permission/rule-loader.js';
import { checkPermission } from '../../core/permission/check.js';
import type { EventEnvelope } from '../../core/event-bus/envelope.js';

// 设计锚点 2.4：文档准入。事件存指针，本体在 git。
// 决策点 G8：基座通过 child_process 调 git 做准入 commit（首版只产事件，git commit 留 main 装配接入）

function parseSubject(s: string): EventEnvelope['subject'] {
  const [kind, id] = s.split(':');
  if (kind === 'agent') return { kind: 'agent', agentId: id };
  if (kind === 'human') return { kind: 'human', userId: id };
  return { kind: 'module', module: id };
}

export class AdmissionCommands {
  private bus: EventBus;
  private rules: PermissionRule[];
  constructor(bus: EventBus, rules: PermissionRule[]) { this.bus = bus; this.rules = rules; }

  // 2.4 准入：谁、写了什么、指向哪个文件、依据什么判断
  admit(subject: string, scope: string, filePath: string, basis: string, aggTaskId?: string) {
    const perm = checkPermission(this.rules, subject, 'doc:admit', `doc:${scope}`);
    if (perm.decision === 'deny') throw new Error(`权限拒绝：${subject} 不可准入`);
    return this.bus.publish({
      seq: null, timestamp: Date.now(),
      subject: parseSubject(subject),
      family: 'doc', subtype: 'admitted',
      handles: {}, payload: { scope, filePath, basis, scopeTaskId: aggTaskId }, value: null,
    });
  }

  // 5.9 订阅设置（首版占位，完整订阅逻辑留 F3 补完）
  setSubscription(subject: string, scope: string, agentId: string, subscribed: boolean) {
    const perm = checkPermission(this.rules, subject, 'doc:setSubscription', `doc:${scope}`);
    if (perm.decision === 'deny') throw new Error(`权限拒绝：${subject} 不可设订阅`);
    // 首版：订阅信息存对话投影 watermark 字段（F3 补完 delta 注入逻辑）
    return this.bus.publish({
      seq: null, timestamp: Date.now(),
      subject: parseSubject(subject),
      family: 'dialogue', subtype: 'turnPosted',
      handles: {}, payload: { channel: 'system', content: '', subscription: { scope, agentId, subscribed } }, value: null,
    });
  }
}
