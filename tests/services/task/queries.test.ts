import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskCommands } from '../../src/services/task/commands.js';
import { TaskQueries } from '../../src/services/task/queries.js';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { ProjectionsStore } from '../../src/core/projector/projections-store.js';
import { TasksProjection } from '../../src/core/projector/projections/tasks.js';
import { TaskNodesProjection } from '../../src/core/projector/projections/task-nodes.js';
import { ValueCompareProjection } from '../../src/core/projector/projections/value-compare.js';
import { ProjectionRunner } from '../../src/core/projector/runner.js';
import type { PermissionRule } from '../../src/core/permission/rule-loader.js';

function setup() {
  const eventStore = new EventStore(':memory:');
  const bus = new EventBus(eventStore);
  const projStore = new ProjectionsStore(':memory:');
  const projections = [new TasksProjection(), new TaskNodesProjection(), new ValueCompareProjection()];
  const runner = new ProjectionRunner(bus, eventStore, projStore, projections);
  runner.start();
  const rules: PermissionRule[] = [
    { subject: 'human:*', action: 'task:create', object: '*', decision: 'allow' },
    { subject: 'human:*', action: 'task:publishChild', object: '*', decision: 'allow' },
    { subject: 'module:*', action: 'task:assign', object: '*', decision: 'allow' },
  ];
  const commands = new TaskCommands(bus, rules);
  const queries = new TaskQueries(projStore, eventStore);
  return { eventStore, bus, projStore, runner, commands, queries };
}

function publish(bus: EventBus, family: any, subtype: string, subject: any, handles: any, payload: any) {
  bus.publish({ seq: null, timestamp: Date.now(), subject, family, subtype, handles, payload, value: null });
}

describe('TaskQueries 任务查询面', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { ctx.runner.stop(); ctx.projStore.close(); ctx.eventStore.close(); });

  it('taskDetail 返回任务详情', () => {
    ctx.commands.createTask({ taskId: 't1', taskType: 'normal', goal: 'g', acceptanceCriteria: 'c', workspaceId: 'ws-1', priority: 5, createdBy: 'human:u1' });
    const task = ctx.queries.taskDetail('t1');
    expect(task).toBeDefined();
    expect(task!.taskId).toBe('t1');
    expect(task!.goal).toBe('g');
  });

  it('taskDetail 不存在返回 undefined', () => {
    expect(ctx.queries.taskDetail('nonexistent')).toBeUndefined();
  });

  it('workspace 返回工作区所有任务', () => {
    ctx.commands.createTask({ taskId: 't1', taskType: 'normal', goal: 'g', acceptanceCriteria: 'c', workspaceId: 'ws-1', priority: 5, createdBy: 'human:u1' });
    ctx.commands.createTask({ taskId: 't2', taskType: 'normal', goal: 'g2', acceptanceCriteria: 'c', workspaceId: 'ws-1', priority: 1, createdBy: 'human:u1' });
    const tasks = ctx.queries.workspace('ws-1');
    expect(tasks).toHaveLength(2);
  });

  it('loadQueue 返回待加载任务（按优先级排序）', () => {
    ctx.commands.createTask({ taskId: 't1', taskType: 'normal', goal: 'g', acceptanceCriteria: 'c', workspaceId: 'ws-1', priority: 1, createdBy: 'human:u1' });
    ctx.commands.createTask({ taskId: 't2', taskType: 'normal', goal: 'g2', acceptanceCriteria: 'c', workspaceId: 'ws-1', priority: 5, createdBy: 'human:u1' });
    const queue = ctx.queries.loadQueue('ws-1');
    expect(queue[0].taskId).toBe('t2'); // priority 5 在前
  });

  // ---- P.5 任务详情扩充查询面 ----

  it('P.5 taskDag：缺省单节点 + 节点状态随事件推进', () => {
    ctx.commands.createTask({ taskId: 't-dag', taskType: 'normal', goal: 'g', acceptanceCriteria: 'c', workspaceId: 'ws-1', priority: 0, createdBy: 'human:u1' });
    let dag = ctx.queries.taskDag('t-dag');
    expect(dag.dagVersion).toBe(1);
    expect(dag.nodes).toHaveLength(1);
    expect(dag.nodes[0].nodeId).toBe('node-1');
    expect(dag.nodes[0].nodeState).toBe('pending');
    expect(dag.edges).toEqual([]);
    // 提交→underReview；判定 pass→done
    publish(ctx.bus, 'task', 'nodeSubmitted', { kind: 'agent', agentId: 'res-01' }, { taskId: 't-dag' }, { nodeId: 'node-1', material: 'm', isLastNode: true });
    dag = ctx.queries.taskDag('t-dag');
    expect(dag.nodes[0].nodeState).toBe('underReview');
    publish(ctx.bus, 'task', 'nodeJudged', { kind: 'human', userId: 'u1' }, { taskId: 't-dag' }, { nodeId: 'node-1', result: 'pass', judgeNote: 'ok' });
    dag = ctx.queries.taskDag('t-dag');
    expect(dag.nodes[0].nodeState).toBe('done');
  });

  it('P.5 taskDag：显式多节点 DAG 与依赖边', () => {
    ctx.commands.createTask({
      taskId: 't-dag2', taskType: 'normal', goal: 'g', acceptanceCriteria: 'c', workspaceId: 'ws-1', priority: 0, createdBy: 'human:u1',
      dagNodes: [{ nodeId: 'a', goal: 'A' }, { nodeId: 'b', goal: 'B', executor: 'res-02' }],
      dagEdges: [{ from: 'a', to: 'b' }],
    });
    const dag = ctx.queries.taskDag('t-dag2');
    expect(dag.nodes.map((n: any) => n.nodeId)).toEqual(['a', 'b']);
    expect(dag.nodes[1].executor).toBe('res-02');
    expect(dag.edges).toEqual([{ fromNode: 'a', toNode: 'b' }]);
  });

  it('P.5 taskTree：聚合任务子树（含孙任务）；叶子任务树=自身', () => {
    ctx.commands.createTask({ taskId: 'agg', taskType: 'aggregate', goal: '聚合', acceptanceCriteria: 'c', workspaceId: 'ws-1', priority: 0, createdBy: 'human:u1' });
    ctx.commands.publishChildTask('human:u1', 'agg', 'child-1', 'normal', 'c1', 'x', 'ws-1', 0);
    ctx.commands.publishChildTask('human:u1', 'agg', 'child-2', 'normal', 'c2', 'x', 'ws-1', 0);
    // 孙任务：child-1 的子任务（直接发 childPublished 事件）
    publish(ctx.bus, 'task', 'childPublished', { kind: 'human', userId: 'u1' }, { taskId: 'child-1' },
      { childTaskId: 'gc-1', taskType: 'normal', goal: 'g', acceptanceCriteria: 'x', workspaceId: 'ws-1', priority: 0 });
    const tree = ctx.queries.taskTree('agg');
    expect(tree.map((t: any) => t.taskId).sort()).toEqual(['agg', 'child-1', 'child-2', 'gc-1']);
    expect(ctx.queries.taskTree('child-2').map((t: any) => t.taskId)).toEqual(['child-2']);
  });

  it('P.5 feedbackZone：上报/判定/指导回执/指令回执/价值裁决按时间汇聚', () => {
    ctx.commands.createTask({ taskId: 't-fb', taskType: 'normal', goal: 'g', acceptanceCriteria: 'c', workspaceId: 'ws-1', priority: 0, createdBy: 'human:u1' });
    publish(ctx.bus, 'task', 'issueReported', { kind: 'agent', agentId: 'res-01' }, { taskId: 't-fb' }, { issue: '依赖缺失' });
    publish(ctx.bus, 'task', 'nodeJudged', { kind: 'human', userId: 'u1' }, { taskId: 't-fb' }, { nodeId: 'node-1', result: 'reject', rejectReason: '格式不符' });
    publish(ctx.bus, 'task', 'guidanceAcked', { kind: 'agent', agentId: 'res-01' }, { taskId: 't-fb' }, { guidanceId: 'gd-1', ackNote: '已采纳' });
    publish(ctx.bus, 'admin', 'piercingAcked', { kind: 'module', module: 'seam' }, { taskId: 't-fb' }, { agentId: 'res-01', success: false, detail: 'agent 未连接', commandId: 'cmd-1' });
    // 价值裁决：judgeRequest 请求记录 + 回执裁决
    publish(ctx.bus, 'admin', 'piercingIssued', { kind: 'agent', agentId: 'task-admin' }, { taskId: 't-fb' }, { type: 'judgeRequest', question: 'q' });
    publish(ctx.bus, 'admin', 'piercingAcked', { kind: 'module', module: 'seam' }, { taskId: 't-fb' }, { agentId: 'task-admin', success: true, result: 'agree', detail: '判定完成' });

    const fb = ctx.queries.feedbackZone('t-fb');
    const kinds = fb.map((f: any) => f.kind);
    expect(kinds).toContain('issue');
    expect(kinds).toContain('judge');
    expect(kinds).toContain('guidance-ack');
    expect(kinds).toContain('ack');
    expect(kinds).toContain('verdict');
    const judge = fb.find((f: any) => f.kind === 'judge');
    expect(judge.summary).toContain('驳回');
    expect(judge.summary).toContain('格式不符');
    const ack = fb.find((f: any) => f.kind === 'ack' && f.detail.commandId === 'cmd-1');
    expect(ack.summary).toContain('指令失败');
    const verdict = fb.find((f: any) => f.kind === 'verdict');
    expect(verdict.summary).toContain('agree');
  });

  it('P.5 feedbackZone：无 eventStore 时恒空（兼容旧装配）', () => {
    const q = new TaskQueries(ctx.projStore);
    expect(q.feedbackZone('t1')).toEqual([]);
  });
});
