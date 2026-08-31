// 设计锚点 3.3② agent状态机推进
// 澄清5：两层结构 dormant / awakened(idle/working/waiting)，判别联合忠实反映

export type AgentState =
  | { wakeState: 'dormant' }
  | { wakeState: 'awakened'; workState: 'idle' | 'working' | 'waiting' };

export interface AgentTransitionInput {
  currentState: AgentState;
  trigger: 'woken' | 'loaded' | 'submitted' | 'approved' | 'rejected' | 'slept';
}

export interface AgentTransitionResult {
  ok: boolean;
  newState?: AgentState;
  error?: string;
}

export function transitionAgentState(input: AgentTransitionInput): AgentTransitionResult {
  const { currentState, trigger } = input;

  switch (currentState.wakeState) {
    case 'dormant':
      if (trigger === 'woken') return { ok: true, newState: { wakeState: 'awakened', workState: 'idle' } };
      return { ok: false, error: `休眠态不可触发：${trigger}` };

    case 'awakened': {
      const ws = currentState.workState;
      switch (ws) {
        case 'idle':
          if (trigger === 'loaded') return { ok: true, newState: { wakeState: 'awakened', workState: 'working' } };
          if (trigger === 'slept') return { ok: true, newState: { wakeState: 'dormant' } };
          return { ok: false, error: `空闲态不可触发：${trigger}` };

        case 'working':
          if (trigger === 'submitted') return { ok: true, newState: { wakeState: 'awakened', workState: 'waiting' } };
          if (trigger === 'slept') return { ok: true, newState: { wakeState: 'dormant' } };
          return { ok: false, error: `工作态不可触发：${trigger}` };

        case 'waiting':
          if (trigger === 'approved') return { ok: true, newState: { wakeState: 'awakened', workState: 'idle' } };
          if (trigger === 'rejected') return { ok: true, newState: { wakeState: 'awakened', workState: 'working' } };
          if (trigger === 'slept') return { ok: true, newState: { wakeState: 'dormant' } };
          return { ok: false, error: `等待态不可触发：${trigger}` };
      }
    }
  }
}
