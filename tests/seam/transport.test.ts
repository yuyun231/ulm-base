import { describe, it, expect } from 'vitest';
import type { TransportLayer, TransportMessage } from '../../src/seam/transport.js';

describe('TransportLayer 接口', () => {
  it('TransportMessage 含 channel 和 payload', () => {
    const msg: TransportMessage = {
      channel: 'event',
      payload: { type: 'test' },
    };
    expect(msg.channel).toBe('event');
  });

  it('TransportLayer 接口可被 mock 实现', () => {
    const mock: TransportLayer = {
      send: (msg: TransportMessage) => { /* no-op */ },
      onMessage: (handler: (msg: TransportMessage) => void) => () => {},
      close: () => {},
    };
    expect(mock.send).toBeDefined();
    expect(mock.onMessage).toBeDefined();
    expect(mock.close).toBeDefined();
  });
});
