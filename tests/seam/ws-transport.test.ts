import { describe, it, expect } from 'vitest';
import { WsTransportServer } from '../../src/seam/ws-transport.js';

describe('WsTransportServer ws 传输层', () => {
  it('WsTransportServer 可实例化', () => {
    const server = new WsTransportServer(9876);
    expect(server).toBeDefined();
    expect(server.getAddress()).toContain('9876');
    server.close();
  });

  it('实现 TransportLayer 接口', () => {
    const server = new WsTransportServer(9877);
    expect(typeof server.send).toBe('function');
    expect(typeof server.onMessage).toBe('function');
    expect(typeof server.close).toBe('function');
    server.close();
  });
});
