import { randomUUID } from 'node:crypto';
import type { EventBus } from '../core/event-bus/bus.js';
import type { ProjectionsStore } from '../core/projector/projections-store.js';
import type { PermissionRule } from '../core/permission/rule-loader.js';
import { checkPermission } from '../core/permission/check.js';
import type { TransportLayer, TransportMessage } from './transport.js';
import type { EventEnvelope } from '../core/event-bus/envelope.js';

// 设计锚点 8.3：封闭端点7个。集合之外无端点——结构性无入口（6.7）
// 端点路由表是写死的枚举，没有"通配"或"默认"分支

// 8.3 封闭端点清单（9.2 seam.gateway 行）
export const SERVICE_ENDPOINTS = [
  'read',              // 查阅（3.9）
  'consultInitiate',   // 征求决策发起（5.4）
  'reportIssue',       // 上报（4.7）
  'submitMaterial',    // 验证材料提交（4.6）
  'judgeRequest',      // 判定请求（价值判断点）
  'dialoguePost',      // 任务对话发言
  'publishTask',       // 普通任务发布（7.4）
] as const;

export type ServiceEndpoint = typeof SERVICE_ENDPOINTS[number];

interface ServiceRequest {
  type: 'request';
  requestId: string;
  endpoint: string;
  agentId: string;
  args: any;
}

interface ServiceResponse {
  type: 'response';
  requestId: string;
  ok: boolean;
  seq?: number;
  error?: string;
  result?: any;
}

export class ServiceChannel {
  private bus: EventBus;
  private projStore: ProjectionsStore;
  private rules: PermissionRule[];
  private transport: TransportLayer;
  private unsub: (() => void) | null = null;

  constructor(bus: EventBus, projStore: ProjectionsStore, rules: PermissionRule[], transport: TransportLayer) {
    this.bus = bus;
    this.projStore = projStore;
    this.rules = rules;
    this.transport = transport;
  }

  start(): void {
    this.unsub = this.transport.onMessage((msg, connId) => {
      if (msg.channel !== 'service') return;
      this.handleServiceRequest(msg, connId);
    });
  }

  stop(): void {
    if (this.unsub) { this.unsub(); this.unsub = null; }
  }

  private handleServiceRequest(msg: TransportMessage, connId: string): void {
    const req = msg.payload as ServiceRequest;
    if (req.type !== 'request') return;

    // 8.3 封闭集合校验：端点不在枚举中→拒绝
    if (!SERVICE_ENDPOINTS.includes(req.endpoint as ServiceEndpoint)) {
      this.sendResponse(req.requestId, false, { error: `未知端点：${req.endpoint}（封闭集合，6.7 结构性无入口）` }, connId);
      return;
    }

    // 路由到对应处理器
    try {
      this.route(req, connId);
    } catch (err: any) {
      this.sendResponse(req.requestId, false, { error: err.message }, connId);
    }
  }

  private route(req: ServiceRequest, connId: string): void {
    const subject: EventEnvelope['subject'] = { kind: 'agent', agentId: req.agentId };
    const args = req.args;

    switch (req.endpoint as ServiceEndpoint) {
      case 'read': {
        const perm = checkPermission(this.rules, `agent:${req.agentId}`, 'doc:read', `doc:${args.docId}`);
        if (perm.decision === 'deny') throw new Error('权限拒绝：查阅');
        const ack = this.bus.publish({
          seq: null, timestamp: Date.now(), subject,
          family: 'schedule', subtype: 'docRead', handles: {},
          payload: { scope: args.scope, docId: args.docId, version: args.version }, value: null,
        });
        this.sendResponse(req.requestId, true, { seq: ack.seq }, connId);
        break;
      }
      case 'submitMaterial': {
        const perm = checkPermission(this.rules, `agent:${req.agentId}`, 'task:submitMaterial', `task:${args.taskId}`);
        if (perm.decision === 'deny') throw new Error('权限拒绝：提交材料');
        const ack = this.bus.publish({
          seq: null, timestamp: Date.now(), subject,
          family: 'task', subtype: 'nodeSubmitted', handles: { taskId: args.taskId },
          payload: { nodeId: args.nodeId, material: args.material, isLastNode: args.isLastNode }, value: null,
        });
        this.sendResponse(req.requestId, true, { seq: ack.seq }, connId);
        break;
      }
      case 'reportIssue': {
        const perm = checkPermission(this.rules, `agent:${req.agentId}`, 'task:reportIssue', `task:${args.taskId}`);
        if (perm.decision === 'deny') throw new Error('权限拒绝：上报');
        const ack = this.bus.publish({
          seq: null, timestamp: Date.now(), subject,
          family: 'task', subtype: 'issueReported', handles: { taskId: args.taskId },
          payload: { issue: args.issue }, value: null,
        });
        this.sendResponse(req.requestId, true, { seq: ack.seq }, connId);
        break;
      }
      case 'consultInitiate': {
        const perm = checkPermission(this.rules, `agent:${req.agentId}`, 'comm:initiate', `task:${args.taskId}`);
        if (perm.decision === 'deny') throw new Error('权限拒绝：征求决策');
        const ack = this.bus.publish({
          seq: null, timestamp: Date.now(), subject,
          family: 'comm', subtype: 'consultInitiated', handles: { taskId: args.taskId },
          payload: {
            aggregateTaskId: args.aggregateTaskId, question: args.question,
            initiatorAgentId: req.agentId,
            sourceDialogueId: args.sourceDialogueId,
            sourceTaskId: args.sourceTaskId,
            targetAgentId: args.targetAgentId ?? 'plan-assistant',
          }, value: null,
        });
        this.sendResponse(req.requestId, true, { seq: ack.seq }, connId);
        break;
      }
      case 'judgeRequest': {
        // Phase 0 修复⑩：判定请求权限检查（4.3 判定人 = task:judge；此前是唯一无权限检查的端点）
        const perm = checkPermission(this.rules, `agent:${req.agentId}`, 'task:judge', `task:${args.taskId}`);
        if (perm.decision === 'deny') throw new Error('权限拒绝：判定请求');
        // F4：基座只做请求转发
        // Phase 0 修复①：commandId 贯通 piercingIssued / 线载指令 / 回执；nodeId 供判定结果转 nodeJudged
        const commandId = randomUUID();
        // 产 piercingIssued 事件（记录判定请求载荷）
        this.bus.publish({
          seq: null, timestamp: Date.now(), subject,
          family: 'admin', subtype: 'piercingIssued',
          handles: {
            taskId: args.taskId,
            purposeId: args.purposeId,
            ...(args.nodeId ? { nodeId: args.nodeId } : {}),
          },
          payload: { type: 'judgeRequest', agentId: req.agentId, commandId,
            taskId: args.taskId, nodeId: args.nodeId, question: args.question, context: args.context },
          value: null,
        });
        // 经 control 通道发 judgeResult 指令到内核（语义：请求判定）
        // 注意：judgeResult 语义从"送达结果"改为"请求判定"（用户确认）
        // E.1 多连接：判定请求指令定向发回请求方连接
        this.transport.sendTo(connId, {
          channel: 'control',
          payload: { type: 'command', command: 'judgeResult', agentId: req.agentId, commandId,
            taskId: args.taskId, purposeId: args.purposeId, nodeId: args.nodeId,
            question: args.question, context: args.context },
        });
        this.sendResponse(req.requestId, true, { result: 'forwarded', commandId }, connId);
        break;
      }
      case 'dialoguePost': {
        const perm = checkPermission(this.rules, `agent:${req.agentId}`, 'dialogue:post', `dialogue:${args.dialogueId}`);
        if (perm.decision === 'deny') throw new Error('权限拒绝：对话发言');
        const ack = this.bus.publish({
          seq: null, timestamp: Date.now(), subject,
          family: 'dialogue', subtype: 'turnPosted', handles: { dialogueId: args.dialogueId },
          payload: { channel: args.channel, content: args.content }, value: null,
        });
        this.sendResponse(req.requestId, true, { seq: ack.seq }, connId);
        break;
      }
      case 'publishTask': {
        // 7.4 普通任务发布（agent 给 agent 派任务）
        // Phase 0 修复⑩：补权限检查（此前与 judgeRequest 一样是无检查端点）+ createdBy 补齐
        const perm = checkPermission(this.rules, `agent:${req.agentId}`, 'task:create', `task:${args.taskId}`);
        if (perm.decision === 'deny') throw new Error('权限拒绝：发布任务');
        const ack = this.bus.publish({
          seq: null, timestamp: Date.now(), subject,
          family: 'task', subtype: 'created', handles: { taskId: args.taskId },
          payload: { taskType: 'normal', goal: args.goal, acceptanceCriteria: args.acceptanceCriteria,
            workspaceId: args.workspaceId, priority: args.priority ?? 0, createdBy: `agent:${req.agentId}` }, value: null,
        });
        this.sendResponse(req.requestId, true, { seq: ack.seq }, connId);
        break;
      }
    }
  }

  // E.1 多连接：回复定向回请求方连接（connId 缺省空串时保持广播兼容）
  private sendResponse(requestId: string, ok: boolean, extra: any = {}, connId = ''): void {
    const response: ServiceResponse = { type: 'response', requestId, ok, ...extra };
    if (connId) {
      this.transport.sendTo(connId, { channel: 'service', payload: response });
    } else {
      this.transport.send({ channel: 'service', payload: response });
    }
  }
}
