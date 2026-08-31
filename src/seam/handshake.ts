import type { EventBus } from '../core/event-bus/bus.js';
import type { TransportLayer, TransportMessage } from './transport.js';
import type { ConnectionRegistry } from './connection-registry.js';
import type { ProjectionsStore } from '../core/projector/projections-store.js';

// 设计锚点 8.7：握手——注册/心跳/失联
// 注册→agents 投影更新（经 woken 事件）
// 心跳→更新 lastActivityAt
// 超时→agentLost 事件

export interface HandshakeConfig {
  intervalSec: number;
  timeoutSec: number;
}

export class HandshakeChannel {
  private bus: EventBus;
  private transport: TransportLayer;
  private config: HandshakeConfig;
  private registry: ConnectionRegistry | null;
  private projStore: ProjectionsStore | null;
  private lastHeartbeat: Map<string, number> = new Map();
  private unsub: (() => void) | null = null;
  private unsubDisconnect: (() => void) | null = null;

  // E.1 多连接：registry 可选——传入则注册时绑定 agentId↔connId、断连时解绑
  // Phase F.1：projStore 可选——传入则 register 走白名单准入（D1）+ capabilities 权威裁决（D3）
  constructor(bus: EventBus, transport: TransportLayer, config: HandshakeConfig, registry?: ConnectionRegistry, projStore?: ProjectionsStore) {
    this.bus = bus;
    this.transport = transport;
    this.config = config;
    this.registry = registry ?? null;
    this.projStore = projStore ?? null;
  }

  start(): void {
    this.unsub = this.transport.onMessage((msg, connId) => {
      if (msg.channel !== 'control') return;
      const payload = msg.payload as { type: string };
      if (payload.type === 'register') this.handleRegister(msg.payload as any, connId);
      else if (payload.type === 'heartbeat') this.handleHeartbeat(msg.payload as any);
    });
    // E.1：断连清理注册表绑定
    if (this.registry) {
      this.unsubDisconnect = this.transport.onDisconnect((connId) => {
        this.registry!.unbindByConn(connId);
      });
    }
  }

  stop(): void {
    if (this.unsub) { this.unsub(); this.unsub = null; }
    if (this.unsubDisconnect) { this.unsubDisconnect(); this.unsubDisconnect = null; }
  }

  // 8.7 注册：agent身份/职能/能力声明→基座注册表
  private handleRegister(data: { agentId: string; role: string; capabilities: string[] }, connId: string): void {
    // Phase F.1 D1/D3：白名单准入 + capabilities 权威裁决（projStore 未注入时保持旧路径兼容）
    if (this.projStore) {
      const row = this.projStore.get('SELECT * FROM agent_registry WHERE agentId = ?', data.agentId) as any;
      if (!row || row.enabled !== 1) {
        const detail = row ? 'agent disabled' : 'unregistered';
        this.bus.publish({
          seq: null, timestamp: Date.now(),
          subject: { kind: 'agent', agentId: data.agentId },
          family: 'admin', subtype: 'agentRegisterRejected', handles: {},
          payload: { agentId: data.agentId, detail }, value: null,
        });
        this.reply(connId, { type: 'registerRejected', agentId: data.agentId, detail });
        return;
      }
      const declared: string[] = JSON.parse(row.capabilities ?? '[]');
      if (!capabilitySetsEqual(declared, data.capabilities ?? [])) {
        this.bus.publish({
          seq: null, timestamp: Date.now(),
          subject: { kind: 'agent', agentId: data.agentId },
          family: 'admin', subtype: 'agentCapabilityMismatch', handles: {},
          payload: { agentId: data.agentId, declared, reported: data.capabilities ?? [] }, value: null,
        });
      }
    }
    // 产 woken 调度事件（注册表投影在 agents 投影消费）
    this.bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId: data.agentId },
      family: 'schedule', subtype: 'woken', handles: {},
      payload: { role: data.role, capabilities: data.capabilities }, value: null,
    });
    this.lastHeartbeat.set(data.agentId, Date.now());
    // E.1：注册即绑定 agentId↔connId（重复 register 覆盖旧绑定，决策3）
    if (this.registry) this.registry.bind(data.agentId, connId);
    // 回 registered（定向回注册连接；无 connId 的旧路径保持广播兼容）
    this.reply(connId, { type: 'registered', agentId: data.agentId });
  }

  // 回执辅助（定向优先，空 connId 广播兼容——既有 registered 回执语义）
  private reply(connId: string, payload: object): void {
    if (connId) {
      this.transport.sendTo(connId, { channel: 'control', payload: payload as any });
    } else {
      this.transport.send({ channel: 'control', payload: payload as any });
    }
  }

  // 8.7 心跳
  private handleHeartbeat(data: { agentId: string }): void {
    this.lastHeartbeat.set(data.agentId, Date.now());
  }

  // 8.7 超时检查→标记失联
  checkHeartbeatTimeout(): string[] {
    const now = Date.now();
    const timeoutMs = this.config.timeoutSec * 1000;
    const expired: string[] = [];
    for (const [agentId, lastBeat] of this.lastHeartbeat) {
      if (now - lastBeat > timeoutMs) {
        expired.push(agentId);
        // 产 agentLost 事件
        this.bus.publish({
          seq: null, timestamp: Date.now(),
          subject: { kind: 'agent', agentId },
          family: 'schedule', subtype: 'agentLost', handles: {},
          payload: {}, value: null,
        });
        this.lastHeartbeat.delete(agentId);
      }
    }
    return expired;
  }
}

// Phase F.1 D3：capabilities 集合等价比较（顺序无关）
function capabilitySetsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort(); const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}
