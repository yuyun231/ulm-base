import { WebSocketServer, WebSocket } from 'ws';
import type { TransportLayer, TransportMessage } from './transport.js';

// 决策点 G7/G9：生产用 ws 实现 TransportLayer 接口
// 基座作为 WebSocket server，内核作为 client 连接
// E.1 多连接补完（8.1 多内核各自一条）：连接池 Map<connId, ws>，connId 自增，
// send=广播全部连接，sendTo=定向单连接，close 触发断连回调

export class WsTransportServer implements TransportLayer {
  private wss: WebSocketServer;
  private conns: Map<string, WebSocket> = new Map();
  private handlers: ((msg: TransportMessage, connId: string) => void)[] = [];
  private disconnectHandlers: ((connId: string) => void)[] = [];
  private nextConn = 1;
  private port: number;

  constructor(port: number) {
    this.port = port;
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', (ws) => {
      const connId = `conn-${this.nextConn++}`;
      this.conns.set(connId, ws);
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as TransportMessage;
          for (const h of this.handlers) h(msg, connId);
        } catch { /* 忽略非法 JSON */ }
      });
      ws.on('close', () => {
        if (this.conns.delete(connId)) {
          for (const h of this.disconnectHandlers) h(connId);
        }
      });
    });
  }

  send(msg: TransportMessage): void {
    for (const ws of this.conns.values()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    }
  }

  sendTo(connId: string, msg: TransportMessage): void {
    const ws = this.conns.get(connId);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
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
    for (const ws of this.conns.values()) ws.close();
    this.conns.clear();
    this.wss.close();
    this.handlers = [];
    this.disconnectHandlers = [];
  }

  getAddress(): string {
    return `ws://localhost:${this.port}`;
  }
}
