import { EventStore } from './store.js';
import { nextSeq } from './sequencer.js';
import { validateEnvelope } from './envelope.js';
import type { EventEnvelope, StoredEventEnvelope, EventFamily } from './envelope.js';

// 设计锚点 3.1：总线 = 校验→赋seq→落库→广播。唯一写入口+定序器。
// 原子性：校验失败→不赋seq不落库不广播；赋seq+落库成功→广播（广播异常不影响落库）。

export interface SubscriptionFilter {
  family?: EventFamily;
  subtype?: string;
}

export type Subscriber = (env: StoredEventEnvelope) => void;

export interface PublishAck {
  seq: number;
}

interface Subscription {
  subscriber: Subscriber;
  filter?: SubscriptionFilter;
}

export class EventBus {
  private store: EventStore;
  private subscriptions: Subscription[] = [];

  constructor(store: EventStore) {
    this.store = store;
  }

  // 3.1 唯一写入口：校验→赋seq→落库→广播
  publish(env: EventEnvelope): PublishAck {
    // 1. 校验信封
    validateEnvelope(env);
    // 2. 赋单调递增 seq
    const seq = nextSeq(this.store.getMaxSeq());
    const stored: StoredEventEnvelope = { ...env, seq };
    // 3. 落库（append-only）
    this.store.append(stored);
    // 4. 广播订阅者（异常隔离，不影响落库）
    this.broadcast(stored);
    return { seq };
  }

  subscribe(subscriber: Subscriber, filter?: SubscriptionFilter): () => void {
    const sub: Subscription = { subscriber, filter };
    this.subscriptions.push(sub);
    return () => {
      const idx = this.subscriptions.indexOf(sub);
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
  }

  private broadcast(env: StoredEventEnvelope): void {
    for (const sub of this.subscriptions) {
      if (sub.filter) {
        if (sub.filter.family && env.family !== sub.filter.family) continue;
        if (sub.filter.subtype && env.subtype !== sub.filter.subtype) continue;
      }
      try {
        sub.subscriber(env);
      } catch {
        // 订阅者异常隔离，不影响其他订阅者和已落库事件
      }
    }
  }
}
