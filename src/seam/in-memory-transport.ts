import type { TransportLayer, TransportMessage } from './transport.js';

// 决策点 G9：内存回环测试实现，消息同步传递，适合接缝逻辑的完全脱网测试。
// E.1 多连接补完：InMemoryServer 持有多条客户端连接（connId 自增），
// send=广播全部连接，sendTo=定向单连接，close 触发断连回调。
// createInMemoryPair() 保持原语义：单客户端对（既有 12 个 seam 测试的回归保护）。

class InMemoryClient implements TransportLayer {
  private server: InMemoryServer | null;
  private handlers: ((msg: TransportMessage, connId: string) => void)[] = [];
  private closed = false;
  readonly connId: string;

  constructor(server: InMemoryServer, connId: string) {
    this.server = server;
    this.connId = connId;
  }

  send(msg: TransportMessage): void {
    if (this.closed || !this.server) return;
    this.server.receiveFromClient(this.connId, msg);
  }

  // 客户端侧无多连接语义：与 send 等价（唯一对端是 server）
  sendTo(_connId: string, msg: TransportMessage): void {
    this.send(msg);
  }

  onMessage(handler: (msg: TransportMessage, connId: string) => void): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx >= 0) this.handlers.splice(idx, 1);
    };
  }

  // 客户端侧没有下游连接可断开：空实现
  onDisconnect(_handler: (connId: string) => void): () => void {
    return () => {};
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers = [];
    if (this.server) this.server.clientClosed(this.connId);
    this.server = null;
  }

  // server 调用：向该客户端投递消息（connId 为空串，客户端侧无连接身份）
  deliver(msg: TransportMessage): void {
    if (this.closed) return;
    for (const h of this.handlers) h(msg, '');
  }
}

export class InMemoryServer implements TransportLayer {
  private clients: Map<string, InMemoryClient> = new Map();
  private handlers: ((msg: TransportMessage, connId: string) => void)[] = [];
  private disconnectHandlers: ((connId: string) => void)[] = [];
  private nextConn = 1;
  private closed = false;

  // 新客户端接入，返回带确定性 connId 的客户端端点
  connect(): InMemoryClient {
    if (this.closed) throw new Error('server 已关闭');
    const connId = `client-${this.nextConn++}`;
    const client = new InMemoryClient(this, connId);
    this.clients.set(connId, client);
    return client;
  }

  send(msg: TransportMessage): void {
    if (this.closed) return;
    for (const client of this.clients.values()) client.deliver(msg);
  }

  sendTo(connId: string, msg: TransportMessage): void {
    if (this.closed) return;
    this.clients.get(connId)?.deliver(msg);
  }

  onMessage(handler: (msg: TransportMessage, connId: string) => void): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx >= 0) this.handlers.splice(idx, 1);
    };
  }

  onDisconnect(handler: (connId: string) => void): () => void {
    this.disconnectHandlers.push(handler);
    return () => {
      const idx = this.disconnectHandlers.indexOf(handler);
      if (idx >= 0) this.disconnectHandlers.splice(idx, 1);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers = [];
    this.disconnectHandlers = [];
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }

  // 客户端上行（模块内协作，由 InMemoryClient 调用）：server 端处理器收到 (msg, connId)
  receiveFromClient(connId: string, msg: TransportMessage): void {
    if (this.closed) return;
    for (const h of this.handlers) h(msg, connId);
  }

  // 客户端断开（模块内协作，由 InMemoryClient 调用）：摘除连接 + 触发断连回调
  clientClosed(connId: string): void {
    if (this.clients.delete(connId)) {
      for (const h of this.disconnectHandlers) h(connId);
    }
  }
}

export function createInMemoryPair(): { server: InMemoryServer; client: InMemoryClient } {
  const server = new InMemoryServer();
  const client = server.connect();
  return { server, client };
}
