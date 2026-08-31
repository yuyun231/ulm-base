import { randomUUID } from 'node:crypto';
import type { EventBus } from '../core/event-bus/bus.js';
import type { TransportLayer, TransportMessage } from './transport.js';
import type { EventEnvelope } from '../core/event-bus/envelope.js';
import type { ConnectionRegistry } from './connection-registry.js';

// 设计锚点 8.4：控制流通道（基座→内核，指令-回执）
// 澄清8：fire-and-forget + piercingIssued 事件；回执异步经事件流产 piercingAcked
// 设计锚点 1.3 控制行为：中断/改序/重来/修正
// Phase 0 修复①：commandId 贯通 command / piercingIssued / piercingAcked（ulm-harness Phase 0 第 1 条）

export const CONTROL_COMMANDS = [
  'wake',           // 唤醒（含载荷 8.6）
  'sleep',          // 休眠
  'interrupt',      // 中断
  'reorder',        // 改序
  'redo',           // 重来
  'correct',        // 修正（含指导，标最高遵循优先级 7.10）
  'modelConfig',    // 模型配置下发
  'whitelist',      // 白名单下发
  'agentDef',        // agent定义下发
  'judgeResult',    // 判定请求（F4：语义从"送达结果"改为"请求判定"，基座→内核）
  'inject',         // 对话注入（征求答复回传、用户消息）
] as const;

export type ControlCommand = typeof CONTROL_COMMANDS[number];

function parseSubject(s: string): EventEnvelope['subject'] {
  const [kind, id] = s.split(':');
  if (kind === 'human') return { kind: 'human', userId: id };
  if (kind === 'agent') return { kind: 'agent', agentId: id };
  return { kind: 'module', module: id };
}

export class ControlChannel {
  private bus: EventBus;
  private transport: TransportLayer;
  private registry: ConnectionRegistry | null;
  private unsub: (() => void) | null = null;

  // E.1 多连接：registry 可选——传入则按 agentId 定向 sendTo；不传保持广播兼容
  constructor(bus: EventBus, transport: TransportLayer, registry?: ConnectionRegistry) {
    this.bus = bus;
    this.transport = transport;
    this.registry = registry ?? null;
  }

  start(): void {
    this.unsub = this.transport.onMessage((msg) => {
      if (msg.channel !== 'control') return;
      this.handleAck(msg);
    });
  }

  stop(): void {
    if (this.unsub) { this.unsub(); this.unsub = null; }
  }

  // 8.4 基座→内核发指令（澄清8：fire-and-forget + 落 piercingIssued 事件）
  // Phase 0 修复①：每条指令生成 commandId， piercingIssued 与线载载荷双携带，回执据此关联
  // 返回 piercingIssued 发布回执（含 seq），供命令面调用方审计定位
  sendCommand(subject: string, agentId: string, command: ControlCommand, payload: any = {}): ReturnType<EventBus['publish']> {
    const commandId = randomUUID();
    // 落 piercingIssued 管理操作事件
    const ack = this.bus.publish({
      seq: null, timestamp: Date.now(),
      subject: parseSubject(subject),
      family: 'admin', subtype: 'piercingIssued', handles: {},
      payload: { type: command, agentId, commandId, ...payload }, value: null,
    });
    // 发指令给内核（fire-and-forget，不阻塞等回执）
    // E.1 多连接：有注册表则定向发送；agent 未连接→不投递，合成失败回执落事件（决策2，8.4 回执要求）
    if (this.registry) {
      const connId = this.registry.resolve(agentId);
      if (connId === null) {
        this.bus.publish({
          seq: null, timestamp: Date.now(),
          subject: { kind: 'module', module: 'seam' },
          family: 'admin', subtype: 'piercingAcked',
          handles: {
            ...(payload?.taskId ? { taskId: payload.taskId } : {}),
            ...(payload?.purposeId ? { purposeId: payload.purposeId } : {}),
          },
          payload: { agentId, success: false, detail: 'agent 未连接', commandId }, value: null,
        });
        return ack;
      }
      this.transport.sendTo(connId, {
        channel: 'control',
        payload: { type: 'command', command, agentId, commandId, ...payload },
      });
      return ack;
    }
    this.transport.send({
      channel: 'control',
      payload: { type: 'command', command, agentId, commandId, ...payload },
    });
    return ack;
  }

  // 8.4 内核回执→落 piercingAcked 事件
  // Phase 0 修复①：回执全字段透传（commandId/result/note…），调度器据此关联指令与消费判定结果
  private handleAck(msg: TransportMessage): void {
    const payload = msg.payload as { type: string; agentId?: string; success?: boolean; detail?: string; taskId?: string; purposeId?: string; [k: string]: unknown };
    if (payload.type !== 'ack') return;
    // 方案A（用户拍板）：回执 payload 透传 taskId/purposeId 进 handles，
    // 使生产回执可按 taskId 匹配 value_compare 记录
    const handles: Record<string, string> = {};
    if (payload.taskId) handles.taskId = payload.taskId;
    if (payload.purposeId) handles.purposeId = payload.purposeId;
    const { type: _type, taskId: _taskId, purposeId: _purposeId, ...rest } = payload;
    this.bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'module', module: 'seam' },
      family: 'admin', subtype: 'piercingAcked', handles,
      payload: rest, value: null,
    });
  }
}
