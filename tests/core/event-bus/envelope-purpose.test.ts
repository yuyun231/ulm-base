import { describe, it, expect } from 'vitest';
import { TASK_SUBTYPES, validateEnvelope } from '../../src/core/event-bus/envelope.js';

describe('F10 目的事件子类型', () => {
  it('TASK_SUBTYPES 包含 purposeCreated/purposeConfirmed/purposeLaunched', () => {
    expect(TASK_SUBTYPES).toContain('purposeCreated');
    expect(TASK_SUBTYPES).toContain('purposeConfirmed');
    expect(TASK_SUBTYPES).toContain('purposeLaunched');
  });

  it('purposeCreated 事件通过信封校验', () => {
    expect(() => validateEnvelope({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'u1' },
      family: 'task', subtype: 'purposeCreated',
      handles: { purposeId: 'p1' }, payload: {}, value: null,
    } as any)).not.toThrow();
  });

  it('purposeLaunched 事件通过信封校验', () => {
    expect(() => validateEnvelope({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'u1' },
      family: 'task', subtype: 'purposeLaunched',
      handles: { purposeId: 'p1' }, payload: {}, value: null,
    } as any)).not.toThrow();
  });
});
