import type { EventBus } from '../../core/event-bus/bus.js';
import type { PermissionRule } from '../../core/permission/rule-loader.js';
import { checkPermission } from '../../core/permission/check.js';
import type { EventEnvelope } from '../../core/event-bus/envelope.js';
import type { ProjectionsStore } from '../../core/projector/projections-store.js';

// 设计锚点 9.5：对话四通道（user/task/plan/purpose）
// 澄清9：channel 字段落 turn 记录

function parseSubject(s: string): EventEnvelope['subject'] {
  const [kind, id] = s.split(':');
  if (kind === 'agent') return { kind: 'agent', agentId: id };
  if (kind === 'human') return { kind: 'human', userId: id };
  return { kind: 'module', module: id };
}

type Channel = 'user' | 'task' | 'plan' | 'purpose';

export class DialogueCommands {
  private bus: EventBus;
  private rules: PermissionRule[];
  constructor(bus: EventBus, rules: PermissionRule[]) { this.bus = bus; this.rules = rules; }

  // 开启对话（首 turn 即开对话）
  openDialogue(subject: string, dialogueId: string, channel: Channel, content: string,
    subscription?: { scope: string; agentId: string }) {
    const perm = checkPermission(this.rules, subject, 'dialogue:open', `dialogue:${dialogueId}`);
    if (perm.decision === 'deny') throw new Error(`权限拒绝：${subject} 不可开启对话`);
    const sub = parseSubject(subject);
    return this.bus.publish({
      seq: null, timestamp: Date.now(), subject: sub,
      family: 'dialogue', subtype: 'turnPosted',
      handles: { dialogueId }, payload: { channel, author: subject, content, subscription }, value: null,
    });
  }

  // 发 turn
  postTurn(subject: string, dialogueId: string, channel: Channel, content: string) {
    const perm = checkPermission(this.rules, subject, 'dialogue:post', `dialogue:${dialogueId}`);
    if (perm.decision === 'deny') throw new Error(`权限拒绝：${subject} 不可发 turn`);
    const sub = parseSubject(subject);
    return this.bus.publish({
      seq: null, timestamp: Date.now(), subject: sub,
      family: 'dialogue', subtype: 'turnPosted',
      handles: { dialogueId }, payload: { channel, author: subject, content }, value: null,
    });
  }
}

// 9.2 查询清单：dialogueDetail / mode
export class DialogueQueries {
  private projStore: ProjectionsStore;
  constructor(projStore: ProjectionsStore) { this.projStore = projStore; }

  dialogueDetail(dialogueId: string): any {
    try { return this.projStore.get('SELECT * FROM dialogues WHERE dialogueId = ?', dialogueId) ?? undefined; }
    catch { return undefined; }
  }

  mode(dialogueId: string): string | undefined {
    const d = this.dialogueDetail(dialogueId);
    return d?.mode;
  }
}
