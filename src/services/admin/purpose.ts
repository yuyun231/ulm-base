import type { EventBus } from '../../core/event-bus/bus.js';
import type { PermissionRule } from '../../core/permission/rule-loader.js';
import { checkPermission } from '../../core/permission/check.js';
import type { EventEnvelope } from '../../core/event-bus/envelope.js';

// 设计锚点 7.5：每次确认＝人的判定命令落事件
// 决策：目的命令面放 admin-service（6.7 仅对人开放）

function parseSubject(s: string): EventEnvelope['subject'] {
  const [kind, id] = s.split(':');
  if (kind === 'human') return { kind: 'human', userId: id };
  if (kind === 'agent') return { kind: 'agent', agentId: id };
  return { kind: 'module', module: id };
}

export class PurposeCommands {
  private bus: EventBus;
  private rules: PermissionRule[];
  constructor(bus: EventBus, rules: PermissionRule[]) { this.bus = bus; this.rules = rules; }

  createPurpose(subject: string, purposeId: string, dialogueId: string, description: string) {
    const perm = checkPermission(this.rules, subject, 'admin:createPurpose', `purpose:${purposeId}`);
    if (perm.decision === 'deny') throw new Error(`权限拒绝`);
    return this.bus.publish({
      seq: null, timestamp: Date.now(), subject: parseSubject(subject),
      family: 'task', subtype: 'purposeCreated',
      handles: { purposeId }, payload: { dialogueId, description }, value: null,
    });
  }

  confirmPurpose(subject: string, purposeId: string, confirmedState: string) {
    const perm = checkPermission(this.rules, subject, 'admin:confirmPurpose', `purpose:${purposeId}`);
    if (perm.decision === 'deny') throw new Error(`权限拒绝`);
    return this.bus.publish({
      seq: null, timestamp: Date.now(), subject: parseSubject(subject),
      family: 'task', subtype: 'purposeConfirmed',
      handles: { purposeId }, payload: { confirmedState }, value: null,
    });
  }

  launchPurpose(subject: string, purposeId: string, taskId: string) {
    const perm = checkPermission(this.rules, subject, 'admin:launchPurpose', `purpose:${purposeId}`);
    if (perm.decision === 'deny') throw new Error(`权限拒绝`);
    return this.bus.publish({
      seq: null, timestamp: Date.now(), subject: parseSubject(subject),
      family: 'task', subtype: 'purposeLaunched',
      handles: { purposeId, taskId }, payload: {}, value: null,
    });
  }
}
