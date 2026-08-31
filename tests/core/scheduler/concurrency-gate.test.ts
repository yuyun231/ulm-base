import { describe, it, expect } from 'vitest';
import { ConcurrencyGate } from '../../src/core/scheduler/concurrency-gate.js';

describe('ConcurrencyGate 并发闸门', () => {
  it('上限4时1个agent可启动', () => {
    const gate = new ConcurrencyGate(4);
    expect(gate.canStart('res-01')).toBe(true);
  });

  it('达上限后不可启动', () => {
    const gate = new ConcurrencyGate(2);
    gate.incrementWorking();
    gate.incrementWorking();
    expect(gate.canStart('res-03')).toBe(false);
  });

  it('hasCapacity 反映剩余容量', () => {
    const gate = new ConcurrencyGate(3);
    expect(gate.hasCapacity()).toBe(true);
    gate.incrementWorking();
    gate.incrementWorking();
    gate.incrementWorking();
    expect(gate.hasCapacity()).toBe(false);
  });

  it('decrementWorking 释放容量', () => {
    const gate = new ConcurrencyGate(2);
    gate.incrementWorking();
    gate.incrementWorking();
    expect(gate.hasCapacity()).toBe(false);
    gate.decrementWorking();
    expect(gate.hasCapacity()).toBe(true);
  });
});
