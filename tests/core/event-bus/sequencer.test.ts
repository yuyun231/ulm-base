import { describe, it, expect } from 'vitest';
import { nextSeq } from '../../src/core/event-bus/sequencer.js';

describe('nextSeq 单调递增序号器', () => {
  it('从 0 开始（无历史事件）', () => {
    expect(nextSeq(0)).toBe(1);
  });

  it('从 5 递增到 6', () => {
    expect(nextSeq(5)).toBe(6);
  });

  it('从 100 递增到 101', () => {
    expect(nextSeq(100)).toBe(101);
  });
});
