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

// 设计锚点 3.8：专注绑定。绑定/解绑本身是一条调度指令，经总线产生调度事件
export class FocusCommands {
  private bus: EventBus;
  private rules: PermissionRule[];
  constructor(bus: EventBus, rules: PermissionRule[]) { this.bus = bus; this.rules = rules; }

  setFocusBinding(subject: string, agentId: string, aggregateTaskId: string | null) {
    const perm = checkPermission(this.rules, subject, 'admin:setFocus', `agent:${agentId}`);
    if (perm.decision === 'deny') throw new Error(`权限拒绝`);
    // 3.8 绑定/解绑经总线产生调度事件（focusBound）
    return this.bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId },
      family: 'schedule', subtype: 'focusBound', handles: {},
      payload: { aggregateTaskId }, value: null,
    });
  }
}
