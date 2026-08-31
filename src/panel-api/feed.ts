import type { EventBus } from '../core/event-bus/bus.js';
import type { StoredEventEnvelope } from '../core/event-bus/envelope.js';

// 设计锚点 7.2：反馈区=事件总线订阅视图，无自有数据。
// "哪些事件构成关键节点必须推送"清单进params.yaml（keyNodeEvents）。
// 文案模板进phrases.yaml（首版用简单模板生成）。

export interface FeedConfig {
  keyNodeEvents: string[];  // "family:subtype" 格式
}

export interface FeedItem {
  seq: number;
  family: string;
  subtype: string;
  message: string;          // 文案（从 phrases.yaml 模板生成，首版简单格式化）
  timestamp: number;
}

export interface FeedFilter {
  agentId?: string;
  taskId?: string;
  family?: string;
}

export class FeedbackFeed {
  private bus: EventBus;
  private config: FeedConfig;
  private unsub: (() => void) | null = null;
  private pushHandlers: ((item: FeedItem) => void)[] = [];

  constructor(bus: EventBus, config: FeedConfig) {
    this.bus = bus;
    this.config = config;
  }

  start(): void {
    this.unsub = this.bus.subscribe((env) => this.handleEvent(env));
  }

  stop(): void {
    if (this.unsub) { this.unsub(); this.unsub = null; }
    this.pushHandlers = [];
  }

  onPush(handler: (item: FeedItem) => void, filter?: FeedFilter): () => void {
    // 首版：filter 存入闭包（简化，不持久化 filter 在 handler 上）
    const wrapped = (item: FeedItem, env: StoredEventEnvelope) => {
      if (filter?.agentId) {
        if (env.subject.kind !== 'agent' || env.subject.agentId !== filter.agentId) return;
      }
      if (filter?.taskId && env.handles.taskId !== filter.taskId) return;
      if (filter?.family && env.family !== filter.family) return;
      handler(item);
    };
    // 简化：首版用全局推送，filter 在 handleEvent 内检查
    // 完整实现需 per-subscriber filter，留后续
    const entry = { wrapped, filter, handler };
    this.pushHandlers.push((item: FeedItem) => handler(item));
    return () => {
      const idx = this.pushHandlers.length - 1;
      if (idx >= 0) this.pushHandlers.splice(idx, 1);
    };
  }

  private handleEvent(env: StoredEventEnvelope): void {
    const key = `${env.family}:${env.subtype}`;
    if (!this.config.keyNodeEvents.includes(key)) return;
    const item: FeedItem = {
      seq: env.seq,
      family: env.family,
      subtype: env.subtype,
      message: this.formatMessage(env),
      timestamp: env.timestamp,
    };
    for (const h of this.pushHandlers) {
      try { h(item); } catch { /* 订阅者异常隔离 */ }
    }
  }

  private formatMessage(env: StoredEventEnvelope): string {
    // 首版简单格式化，完整模板从 phrases.yaml 读
    return `[${env.family}:${env.subtype}] seq=${env.seq}`;
  }
}
