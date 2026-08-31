
// 决策点 G7：JSON 帧 + channel 字段区分三通道
// 决策点 G9：抽象 TransportLayer 接口，测试用内存回环，生产用 ws
// E.1 多连接补完：server 端可持有多条连接（8.1 多内核各自一条），connId 标识单条连接

export type Channel = 'event' | 'service' | 'control';

export interface TransportMessage {
  channel: Channel;
  payload: unknown;
}

// 传输层接口：接缝逻辑依赖此接口，不直接依赖 ws
// server 端语义：send=广播全部连接；sendTo=定向单连接；
// onMessage 回调第二参 connId 标识消息来源连接（客户端侧实现收到的 connId 为空串）
export interface TransportLayer {
  send(msg: TransportMessage): void;
  sendTo(connId: string, msg: TransportMessage): void;
  onMessage(handler: (msg: TransportMessage, connId: string) => void): () => void;
  onDisconnect(handler: (connId: string) => void): () => void;
  close(): void;
}
