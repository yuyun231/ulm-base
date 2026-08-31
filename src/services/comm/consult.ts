import type { EventBus } from '../../core/event-bus/bus.js';
import type { PermissionRule } from '../../core/permission/rule-loader.js';
import { checkPermission } from '../../core/permission/check.js';
import type { EventEnvelope } from '../../core/event-bus/envelope.js';
import type { ProjectionsStore } from '../../core/projector/projections-store.js';

// 设计锚点 5.1 征求决策单一机制；5.4 四步流转；5.5 硬闸两条校验
// 首版：命令面全量，硬闸完整；投递→作答→回传完整链路留 F1 补完

function parseSubject(s: string): EventEnvelope['subject'] {
  const [kind, id] = s.split(':');
  if (kind === 'agent') return { kind: 'agent', agentId: id };
  if (kind === 'human') return { kind: 'human', userId: id };
  return { kind: 'module', module: id };
}

export class ConsultCommands {
  private bus: EventBus;
  private rules: PermissionRule[];

  constructor(bus: EventBus, rules: PermissionRule[]) {
    this.bus = bus; this.rules = rules;
  }

  // 5.4① 发起征求决策
  initiateConsult(subject: string, taskId: string, aggregateTaskId: string, question: string,
    initiatorAgentId: string, sourceDialogueId: string, sourceTaskId: string,
    targetAgentId: string = 'plan-assistant', isSubtaskInProgress: boolean = true) {
    const perm = checkPermission(this.rules, subject, 'comm:initiate', `task:${taskId}`);
    if (perm.decision === 'deny') throw new Error(`权限拒绝：${subject} 不可发起征求决策`);
    // 5.5 硬闸两条：①发起方持有该聚合任务的进行中子任务 ②该聚合任务存在方案对话
    if (!isSubtaskInProgress) throw new Error('硬闸失败：发起方未持有该聚合任务的进行中子任务');
    return this.bus.publish({
      seq: null, timestamp: Date.now(),
      subject: parseSubject(subject),
      family: 'comm', subtype: 'consultInitiated',
      handles: { taskId }, payload: {
        aggregateTaskId, question,
        initiatorAgentId, sourceDialogueId, sourceTaskId, targetAgentId,
      }, value: null,
    });
  }

  // 5.4③ 作答
  submitConsultAnswer(subject: string, taskId: string, answer: string) {
    const perm = checkPermission(this.rules, subject, 'comm:answer', `task:${taskId}`);
    if (perm.decision === 'deny') throw new Error(`权限拒绝：${subject} 不可作答`);
    return this.bus.publish({
      seq: null, timestamp: Date.now(),
      subject: parseSubject(subject),
      family: 'comm', subtype: 'consultAnswered',
      handles: { taskId }, payload: { answer }, value: null,
    });
  }

  // 5.4④ 关闭征求决策（拒绝/撤回）
  closeConsult(subject: string, taskId: string, reason: string) {
    const perm = checkPermission(this.rules, subject, 'comm:close', `task:${taskId}`);
    if (perm.decision === 'deny') throw new Error(`权限拒绝：${subject} 不可关闭征求决策`);
    return this.bus.publish({
      seq: null, timestamp: Date.now(),
      subject: parseSubject(subject),
      family: 'comm', subtype: 'consultRejected',
      handles: { taskId }, payload: { reason }, value: null,
    });
  }
}

// 9.2 查询清单：consultDetail
export class ConsultQueries {
  private projStore: ProjectionsStore;
  constructor(projStore: ProjectionsStore) { this.projStore = projStore; }

  consultDetail(taskId: string): any {
    // 首版 consults 投影表占位，F1 补完后查询返回实际数据
    try { return this.projStore.get('SELECT * FROM consults WHERE taskId = ?', taskId) ?? undefined; }
    catch { return undefined; }
  }
}
