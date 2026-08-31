import { describe, it, expect } from 'vitest';
import { transitionTaskState, type TaskState, type TaskTransitionInput } from '../../src/core/scheduler/task-fsm.js';

describe('transitionTaskState 任务状态机', () => {
  it('待办→进行（assigned）', () => {
    const result = transitionTaskState({ currentState: 'pending', trigger: 'assigned' });
    expect(result.ok).toBe(true);
    expect(result.newState).toBe('inProgress');
  });

  it('进行→审批（末节点提交 nodeSubmitted）', () => {
    const result = transitionTaskState({ currentState: 'inProgress', trigger: 'nodeSubmitted', isLastNode: true });
    expect(result.ok).toBe(true);
    expect(result.newState).toBe('underReview');
  });

  it('非末节点提交不改任务状态', () => {
    const result = transitionTaskState({ currentState: 'inProgress', trigger: 'nodeSubmitted', isLastNode: false });
    expect(result.ok).toBe(true);
    expect(result.newState).toBe('inProgress');
  });

  it('审批→完成（nodeJudged pass）', () => {
    const result = transitionTaskState({ currentState: 'underReview', trigger: 'nodeJudged', judgeResult: 'pass' });
    expect(result.ok).toBe(true);
    expect(result.newState).toBe('done');
  });

  it('审批→进行（驳回，4.8补充1默认回进行）', () => {
    const result = transitionTaskState({ currentState: 'underReview', trigger: 'nodeJudged', judgeResult: 'reject' });
    expect(result.ok).toBe(true);
    expect(result.newState).toBe('inProgress');
  });

  it('审批→待办（驳回重排，4.8补充1可选）', () => {
    const result = transitionTaskState({ currentState: 'underReview', trigger: 'nodeJudged', judgeResult: 'reject', rejectToBacklog: true });
    expect(result.ok).toBe(true);
    expect(result.newState).toBe('pending');
  });

  it('进行→暂停', () => {
    const result = transitionTaskState({ currentState: 'inProgress', trigger: 'pause' });
    expect(result.ok).toBe(true);
    expect(result.newState).toBe('paused');
  });

  it('暂停→进行', () => {
    const result = transitionTaskState({ currentState: 'paused', trigger: 'resume' });
    expect(result.ok).toBe(true);
    expect(result.newState).toBe('inProgress');
  });

  it('非法迁移拒绝（待办不能直接完成）', () => {
    const result = transitionTaskState({ currentState: 'pending', trigger: 'nodeJudged', judgeResult: 'pass' });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});
