import type { EventBus } from '../core/event-bus/bus.js';
import type { TransportLayer, TransportMessage } from './transport.js';
import type { EventEnvelope } from '../core/event-bus/envelope.js';

// 设计锚点 8.2：事件流通道（内核→基座，异步流）
// 承载①器官事件与⑤对话事件。每条基座回 ack（写库成功才返 ack）
// 基座只对"可还原性"提要求，不规定内核怎么切粒度

export class EventChannel {
  private bus: EventBus;
  private transport: TransportLayer;
  private unsub: (() => void) | null = null;

  constructor(bus: EventBus, transport: TransportLayer) {
    this.bus = bus;
    this.transport = transport;
  }

  start(): void {
    this.unsub = this.transport.onMessage((msg, connId) => {
      if (msg.channel !== 'event') return;
      this.handleEventMessage(msg, connId);
    });
  }

  stop(): void {
    if (this.unsub) { this.unsub(); this.unsub = null; }
  }

  private handleEventMessage(msg: TransportMessage, connId: string): void {
    const payload = msg.payload as { type: string; event?: EventEnvelope };
    if (payload.type !== 'emit' || !payload.event) return;

    try {
      // 经总线校验→赋seq→落库→广播
      // E.1 多连接：ack 定向回给上报方连接
      const ack = this.bus.publish(payload.event);
      this.transport.sendTo(connId, {
        channel: 'event',
        payload: { type: 'ack', seq: ack.seq },
      });
    } catch (err: any) {
      // 校验失败：不落库，回错误 ack
      this.transport.sendTo(connId, {
        channel: 'event',
        payload: { type: 'ack', error: err.message },
      });
    }
  }
}
