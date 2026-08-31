// 设计锚点 4.1 任务状态：待办/进行/暂停/审批/完成
// 设计锚点 4.8 补充1：驳回回进行或待办
// 澄清4：审批=末节点提交触发

export type TaskState = 'pending' | 'inProgress' | 'paused' | 'underReview' | 'done';

export interface TaskTransitionInput {
  currentState: TaskState;
  trigger: 'assigned' | 'nodeSubmitted' | 'nodeJudged' | 'pause' | 'resume';
  isLastNode?: boolean;   // nodeSubmitted 时使用
  judgeResult?: 'pass' | 'reject';  // nodeJudged 时使用
  rejectToBacklog?: boolean;        // 驳回时可选回待办
}

export interface TaskTransitionResult {
  ok: boolean;
  newState?: TaskState;
  error?: string;
}

export function transitionTaskState(input: TaskTransitionInput): TaskTransitionResult {
  const { currentState, trigger } = input;

  switch (trigger) {
    case 'assigned':
      if (currentState === 'pending') {
        return { ok: true, newState: 'inProgress' };
      }
      return { ok: false, error: `非法迁移：${currentState} 不能通过 assigned 迁移` };

    case 'nodeSubmitted':
      if (currentState !== 'inProgress') {
        return { ok: false, error: `非法迁移：${currentState} 不能通过 nodeSubmitted 迁移` };
      }
      // 澄清4：末节点提交→审批，非末节点提交不改任务状态
      if (input.isLastNode) {
        return { ok: true, newState: 'underReview' };
      }
      return { ok: true, newState: 'inProgress' };

    case 'nodeJudged':
      if (currentState !== 'underReview') {
        return { ok: false, error: `非法迁移：${currentState} 不能通过 nodeJudged 迁移` };
      }
      if (input.judgeResult === 'pass') {
        return { ok: true, newState: 'done' };
      }
      // 4.8 补充1：驳回→进行（默认）或待办（可选）
      return { ok: true, newState: input.rejectToBacklog ? 'pending' : 'inProgress' };

    case 'pause':
      if (currentState === 'inProgress') {
        return { ok: true, newState: 'paused' };
      }
      return { ok: false, error: `非法迁移：${currentState} 不能通过 pause 迁移` };

    case 'resume':
      if (currentState === 'paused') {
        return { ok: true, newState: 'inProgress' };
      }
      return { ok: false, error: `非法迁移：${currentState} 不能通过 resume 迁移` };

    default:
      return { ok: false, error: `未知触发器：${trigger}` };
  }
}
