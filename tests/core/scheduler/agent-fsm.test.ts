import { describe, it, expect } from 'vitest';
import { transitionAgentState, type AgentState, type AgentTransitionInput } from '../../src/core/scheduler/agent-fsm.js';

describe('transitionAgentState agent两层状态机', () => {
  it('休眠→唤醒空闲（woken）', () => {
    const result = transitionAgentState({ currentState: { wakeState: 'dormant' }, trigger: 'woken' });
    expect(result.ok).toBe(true);
    expect(result.newState?.wakeState).toBe('awakened');
    expect(result.newState?.workState).toBe('idle');
  });

  it('唤醒空闲→工作（loaded）', () => {
    const result = transitionAgentState({ currentState: { wakeState: 'awakened', workState: 'idle' }, trigger: 'loaded' });
    expect(result.ok).toBe(true);
    expect(result.newState?.workState).toBe('working');
  });

  it('工作→等待（submitted，提交验证材料）', () => {
    const result = transitionAgentState({ currentState: { wakeState: 'awakened', workState: 'working' }, trigger: 'submitted' });
    expect(result.ok).toBe(true);
    expect(result.newState?.workState).toBe('waiting');
  });

  it('等待→空闲（approved，审批通过）', () => {
    const result = transitionAgentState({ currentState: { wakeState: 'awakened', workState: 'waiting' }, trigger: 'approved' });
    expect(result.ok).toBe(true);
    expect(result.newState?.workState).toBe('idle');
  });

  it('等待→工作（rejected，驳回继续）', () => {
    const result = transitionAgentState({ currentState: { wakeState: 'awakened', workState: 'waiting' }, trigger: 'rejected' });
    expect(result.ok).toBe(true);
    expect(result.newState?.workState).toBe('working');
  });

  it('唤醒任意态→休眠（slept）', () => {
    const result = transitionAgentState({ currentState: { wakeState: 'awakened', workState: 'working' }, trigger: 'slept' });
    expect(result.ok).toBe(true);
    expect(result.newState?.wakeState).toBe('dormant');
    expect(result.newState?.workState).toBeUndefined();
  });

  it('休眠不能直接loaded', () => {
    const result = transitionAgentState({ currentState: { wakeState: 'dormant' }, trigger: 'loaded' });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('工作不能直接approved（必须先waiting）', () => {
    const result = transitionAgentState({ currentState: { wakeState: 'awakened', workState: 'working' }, trigger: 'approved' });
    expect(result.ok).toBe(false);
  });
});
