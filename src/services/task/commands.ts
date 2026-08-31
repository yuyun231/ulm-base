import type { EventBus } from '../../core/event-bus/bus.js';
import type { PermissionRule } from '../../core/permission/rule-loader.js';
import { checkPermission } from '../../core/permission/check.js';
import type { EventEnvelope } from '../../core/event-bus/envelope.js';

// 设计锚点 3.5：命令（写，必须经总线产事件）+ 3.6（权限校验点）
// 设计锚点 4.1-4.8 任务模块全部命令

function parseSubject(subjectStr: string): EventEnvelope['subject'] {
  const [kind, id] = subjectStr.split(':');
  if (kind === 'agent') return { kind: 'agent', agentId: id };
  if (kind === 'human') return { kind: 'human', userId: id };
  return { kind: 'module', module: id };
}

// Phase 0 修复⑥：DAG 输入（缺省时 createTask 自动生成单节点 node-1）
// 节点字段与 task-nodes 投影消费一致；边用 from/to（投影 task_edges 列 fromNode/toNode）
export interface DagNodeInput { nodeId: string; goal?: string; acceptanceCriteria?: string; executor?: string; }
export interface DagEdgeInput { from: string; to: string; }

export interface CreateTaskInput {
  taskId: string; taskType: string; goal: string;
  acceptanceCriteria: string; workspaceId: string;
  priority: number; createdBy: string;
  parentTaskId?: string; dialogueId?: string;
  originTaskId?: string;        // F.3：再生产物——来源任务
  regenerationDepth?: number;   // F.3：再生产物——代数（仅 trackDepth 规则携带，防环 1）
  requireApproval?: boolean;    // F.3：规则层审批开关（require → 首节点审批卡 require-approval）
  dagNodes?: DagNodeInput[];    // Phase 0 修复⑥：任务管理员拆解的多节点 DAG；缺省=单节点
  dagEdges?: DagEdgeInput[];    // Phase 0 修复⑥：节点依赖边；缺省=无边
}

export class TaskCommands {
  private bus: EventBus;
  private rules: PermissionRule[];

  constructor(bus: EventBus, rules: PermissionRule[]) {
    this.bus = bus;
    this.rules = rules;
  }

  private guard(subject: string, action: string, object: string): void {
    const result = checkPermission(this.rules, subject, action, object);
    if (result.decision === 'deny') {
      throw new Error(`权限拒绝：${subject} 不可 ${action} on ${object}（${result.reason ?? ''}）`);
    }
  }

  private publish(subject: EventEnvelope['subject'], subtype: string, handles: any, payload: any) {
    return this.bus.publish({
      seq: null, timestamp: Date.now(), subject,
      family: 'task', subtype, handles, payload, value: null,
    });
  }

  // 4.1 创建任务
  // Phase 0 修复⑥：缺省 DAG 自动生成单节点 node-1（execute），普通任务由此获得可判定节点
  createTask(input: CreateTaskInput) {
    this.guard(input.createdBy, 'task:create', `task:${input.taskId}`);
    const dagNodes = input.dagNodes && input.dagNodes.length > 0
      ? input.dagNodes
      : [{ nodeId: 'node-1', goal: input.goal, acceptanceCriteria: input.acceptanceCriteria }];
    const dagEdges = input.dagEdges ?? [];
    return this.publish(parseSubject(input.createdBy), 'created',
      { taskId: input.taskId, workspaceId: input.workspaceId },
      { taskType: input.taskType, goal: input.goal, acceptanceCriteria: input.acceptanceCriteria,
        priority: input.priority, parentTaskId: input.parentTaskId, dialogueId: input.dialogueId,
        workspaceId: input.workspaceId, dagNodes, dagEdges,
        ...(input.originTaskId != null ? { originTaskId: input.originTaskId } : {}),
        ...(input.regenerationDepth != null ? { regenerationDepth: input.regenerationDepth } : {}),
        ...(input.requireApproval ? { requireApproval: true } : {}) });
  }

  // 4.8 分配
  assign(subject: string, taskId: string, agentId: string) {
    this.guard(subject, 'task:assign', `task:${taskId}`);
    return this.publish(parseSubject(subject), 'assigned',
      { taskId }, { agentId });
  }

  // 4.6 提交验证材料（澄清4：isLastNode 控制任务级审批触发）
  submitMaterial(subject: string, taskId: string, nodeId: string, material: string, isLastNode: boolean) {
    this.guard(subject, 'task:submitMaterial', `task:${taskId}`);
    return this.publish(parseSubject(subject), 'nodeSubmitted',
      { taskId }, { nodeId, material, isLastNode });
  }

  // 4.3/4.6 审批通过（含判断书写）
  approve(subject: string, taskId: string, nodeId: string, judgeNote: string, result: 'pass') {
    this.guard(subject, 'task:approve', `task:${taskId}`);
    return this.publish(parseSubject(subject), 'nodeJudged',
      { taskId }, { nodeId, result, judgeNote });
  }

  // 4.8 驳回
  reject(subject: string, taskId: string, nodeId: string, rejectReason: string) {
    this.guard(subject, 'task:reject', `task:${taskId}`);
    return this.publish(parseSubject(subject), 'nodeJudged',
      { taskId }, { nodeId, result: 'reject', rejectReason });
  }

  // 4.7 上报问题
  reportIssue(subject: string, taskId: string, issue: string) {
    this.guard(subject, 'task:reportIssue', `task:${taskId}`);
    return this.publish(parseSubject(subject), 'issueReported',
      { taskId }, { issue });
  }

  // 4.7 路径变更申请
  requestPathChange(subject: string, taskId: string, reason: string) {
    this.guard(subject, 'task:requestPathChange', `task:${taskId}`);
    return this.publish(parseSubject(subject), 'pathChangeRequested',
      { taskId }, { reason });
  }

  // 4.5 DAG 重构
  restructureDAG(subject: string, taskId: string, newVersion: number, addNodes: any[], removeNodes: string[],
    addEdges?: any[], removeEdges?: any[]) {
    this.guard(subject, 'task:restructure', `task:${taskId}`);
    return this.publish(parseSubject(subject), 'restructured',
      { taskId }, { newVersion, addNodes, removeNodes, addEdges, removeEdges });
  }

  // 4.4 聚合任务发布子任务
  publishChildTask(subject: string, parentTaskId: string, childTaskId: string, taskType: string, goal: string, acceptanceCriteria: string, workspaceId: string, priority: number) {
    this.guard(subject, 'task:publishChild', `task:${parentTaskId}`);
    return this.publish(parseSubject(subject), 'childPublished',
      { taskId: parentTaskId }, { childTaskId, taskType, goal, acceptanceCriteria, workspaceId, priority });
  }

  // 7.10 下发指导
  issueGuidance(subject: string, taskId: string, guidanceId: string, content: string, type: 'now' | 'future') {
    this.guard(subject, 'task:issueGuidance', `task:${taskId}`);
    return this.publish(parseSubject(subject), 'guidanceIssued',
      { taskId }, { guidanceId, content, type });
  }

  // 7.11 指导回执
  ackGuidance(subject: string, taskId: string, guidanceId: string, ackNote: string) {
    this.guard(subject, 'task:ackGuidance', `task:${taskId}`);
    return this.publish(parseSubject(subject), 'guidanceAcked',
      { taskId }, { guidanceId, ackNote });
  }
}
