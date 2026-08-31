import type { EventBus } from '../event-bus/bus.js';
import type { EventStore } from '../event-bus/store.js';
import type { ProjectionsStore } from './projections-store.js';
import type { StoredEventEnvelope } from '../event-bus/envelope.js';

// 投影接口：每个投影实现这三个方法
export interface Projection {
  initSchema(db: ProjectionsStore): void;
  applyEvent(db: ProjectionsStore, env: StoredEventEnvelope): void;
}

// 设计锚点 2.3：投影器订阅事件流，全量重放可重建投影。
export class ProjectionRunner {
  private bus: EventBus;
  private eventStore: EventStore;
  private projStore: ProjectionsStore;
  private projections: Projection[];
  private unsub: (() => void) | null = null;

  constructor(bus: EventBus, eventStore: EventStore, projStore: ProjectionsStore, projections: Projection[]) {
    this.bus = bus;
    this.eventStore = eventStore;
    this.projStore = projStore;
    this.projections = projections;
  }

  // 启动：初始化所有投影表 schema + 订阅事件总线
  start(): void {
    for (const proj of this.projections) {
      proj.initSchema(this.projStore);
    }
    this.unsub = this.bus.subscribe((env) => {
      this.projStore.transaction(() => {
        for (const proj of this.projections) {
          proj.applyEvent(this.projStore, env);
        }
      });
    });
  }

  stop(): void {
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
  }

  // 2.3 全量重放：重新初始化投影 → 清空投影表 → 从事件库读全部事件 → 逐条 applyEvent
  replayAll(): void {
    for (const proj of this.projections) {
      proj.initSchema(this.projStore);
    }
    this.projStore.clearAll();
    const allEvents = this.eventStore.getAll();
    for (const env of allEvents) {
      this.projStore.transaction(() => {
        for (const proj of this.projections) {
          proj.applyEvent(this.projStore, env);
        }
      });
    }
  }
}
