import { describe, it, expect } from 'vitest';
import { createInMemoryPair } from '../../src/seam/in-memory-transport.js';

describe('InMemoryTransport 内存回环', () => {
  it('两端互连：server 端发消息 client 端收到', () => {
    const { server, client } = createInMemoryPair();
    const received: any[] = [];
    client.onMessage((msg) => { received.push(msg); });
    server.send({ channel: 'control', payload: { cmd: 'wake' } });
    expect(received).toHaveLength(1);
    expect(received[0].channel).toBe('control');
  });

  it('两端互连：client 端发消息 server 端收到', () => {
    const { server, client } = createInMemoryPair();
    const received: any[] = [];
    server.onMessage((msg) => { received.push(msg); });
    client.send({ channel: 'event', payload: { type: 'action' } });
    expect(received).toHaveLength(1);
    expect(received[0].channel).toBe('event');
  });

  it('close 后消息不再传递', () => {
    const { server, client } = createInMemoryPair();
    const received: any[] = [];
    client.onMessage((msg) => { received.push(msg); });
    server.send({ channel: 'control', payload: {} });
    expect(received).toHaveLength(1);
    server.close();
    server.send({ channel: 'control', payload: {} });
    expect(received).toHaveLength(1); // close 后不再收到
  });

  it('取消订阅后不再收到消息', () => {
    const { server, client } = createInMemoryPair();
    const received: any[] = [];
    const unsub = client.onMessage((msg) => { received.push(msg); });
    server.send({ channel: 'control', payload: {} });
    expect(received).toHaveLength(1);
    unsub();
    server.send({ channel: 'control', payload: {} });
    expect(received).toHaveLength(1);
  });
});
