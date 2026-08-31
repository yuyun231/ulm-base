import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskCommands } from '../../src/services/task/commands.js';
import { TaskQueries } from '../../src/services/task/queries.js';
import { EventStore } from '../../src/core/event-bus/store.js';
import { EventBus } from '../../src/core/event-bus/bus.js';
import { ProjectionsStore } from '../../src/core/projector/projections-store.js';
import { TasksProjection } from '../../src/core/projector/projections/tasks.js';
import { TaskNodesProjection } from '../../src/core/projector/projections/task-nodes.js';
import { ProjectionRunner } from '../../src/core/projector/runner.js';
import type { PermissionRule } from '../../src/core/permission/rule-loader.js';

function setup() {
  const eventStore = new EventStore(':memory:');
  const bus = new EventBus(eventStore);
  const projStore = new ProjectionsStore(':memory:');
  const projections = [new TasksProjection(), new TaskNodesProjection()];
  const runner = new ProjectionRunner(bus, eventStore, projStore, projections);
  runner.start();
  const rules: PermissionRule[] = [
    { subject: 'human:*', action: 'task:create', object: '*', decision: 'allow' },
    { subject: 'module:*', action: 'task:assign', object: '*', decision: 'allow' },
    { subject: 'agent:*', action: 'task:submitMaterial', object: 'task:*', decision: 'allow' },
    { subject: 'human:*', action: 'task:approve', object: 'task:*', decision: 'allow' },
    { subject: 'human:*', action: 'task:reject', object: 'task:*', decision: 'allow' },
    { subject: 'agent:*', action: 'task:reportIssue', object: 'task:*', decision: 'allow' },
    { subject: 'agent:*', action: 'task:requestPathChange', object: 'task:*', decision: 'allow' },
    { subject: 'human:*', action: 'task:restructure', object: 'task:*', decision: 'allow' },
    { subject: 'human:*', action: 'task:publishChild', object: 'task:*', decision: 'allow' },
  ];
  const commands = new TaskCommands(bus, rules);
  const queries = new TaskQueries(projStore);
  return { eventStore, bus, projStore, runner, commands, queries };
}

describe('TaskCommands 任务命令面', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => {
    ctx.runner.stop(); ctx.projStore.close(); ctx.eventStore.close();
  });

  it('createTask 产 created 事件', () => {
    const ack = ctx.commands.createTask({
      taskId: 't1', taskType: 'normal', goal: '测试',
      acceptanceCriteria: '通过', workspaceId: 'ws-1',
      priority: 5, createdBy: 'human:u1',
    });
    expect(ack.seq).toBe(1);
    const task = ctx.queries.taskDetail('t1');
    expect(task).toBeDefined();
    expect(task!.state).toBe('pending');
  });

  it('Phase 0 修复⑥：createTask 缺省 DAG → 自动生成单节点 node-1（task_nodes 投影落地）', () => {
    ctx.commands.createTask({
      taskId: 't-dag', taskType: 'normal', goal: '默认节点',
      acceptanceCriteria: 'AC', workspaceId: 'ws-1', priority: 0, createdBy: 'human:u1',
    });
    const node = ctx.projStore.get("SELECT * FROM task_nodes WHERE taskId = 't-dag'") as any;
    expect(node).toBeTruthy();
    expect(node.nodeId).toBe('node-1');
    expect(node.goal).toBe('默认节点');
    expect(node.acceptanceCriteria).toBe('AC');
    expect(node.nodeState).toBe('pending');
  });

  it('Phase 0 修复⑥：createTask 传 dagNodes/dagEdges → 原样落投影（多节点 DAG）', () => {
    ctx.commands.createTask({
      taskId: 't-dag2', taskType: 'normal', goal: '多节点', acceptanceCriteria: 'AC', workspaceId: 'ws-1',
      priority: 0, createdBy: 'human:u1',
      dagNodes: [
        { nodeId: 'a', goal: 'A' },
        { nodeId: 'b', goal: 'B', executor: 'res-02' },
      ],
      dagEdges: [{ from: 'a', to: 'b' }],
    });
    const nodes = ctx.projStore.all("SELECT * FROM task_nodes WHERE taskId = 't-dag2' ORDER BY nodeId") as any[];
    expect(nodes.map(n => n.nodeId)).toEqual(['a', 'b']);
    expect(nodes[1].executor).toBe('res-02');
    const edges = ctx.projStore.all("SELECT * FROM task_edges WHERE taskId = 't-dag2'") as any[];
    expect(edges).toHaveLength(1);
    expect(edges[0].fromNode).toBe('a');
    expect(edges[0].toNode).toBe('b');
  });

  it('createTask 权限拒绝时不产事件', () => {
    expect(() => ctx.commands.createTask({
      taskId: 't1', taskType: 'normal', goal: 'x',
      acceptanceCriteria: 'x', workspaceId: 'ws-1', priority: 0,
      createdBy: 'agent:res-01', // agent 无 create 权限
    })).toThrow();
    expect(ctx.eventStore.getMaxSeq()).toBe(0);
  });

  it('assign 产 assigned 事件', () => {
    ctx.commands.createTask({ taskId: 't1', taskType: 'normal', goal: 'x', acceptanceCriteria: 'x', workspaceId: 'ws-1', priority: 0, createdBy: 'human:u1' });
    const ack = ctx.commands.assign('module:task-service', 't1', 'agent:res-01');
    expect(ack.seq).toBe(2);
  });

  it('submitMaterial 产 nodeSubmitted 事件', () => {
    ctx.commands.createTask({ taskId: 't1', taskType: 'normal', goal: 'x', acceptanceCriteria: 'x', workspaceId: 'ws-1', priority: 0, createdBy: 'human:u1' });
    ctx.commands.assign('module:task-service', 't1', 'agent:res-01');
    const ack = ctx.commands.submitMaterial('agent:res-01', 't1', 'n1', '材料内容', true);
    expect(ack.seq).toBe(3);
  });

  it('approve 产 nodeJudged 事件（pass）', () => {
    ctx.commands.createTask({ taskId: 't1', taskType: 'normal', goal: 'x', acceptanceCriteria: 'x', workspaceId: 'ws-1', priority: 0, createdBy: 'human:u1' });
    ctx.commands.assign('module:task-service', 't1', 'agent:res-01');
    ctx.commands.submitMaterial('agent:res-01', 't1', 'n1', '材料', true);
    const ack = ctx.commands.approve('human:u1', 't1', 'n1', '通过', 'pass');
    expect(ack.seq).toBe(4);
  });

  it('reject 产 nodeJudged 事件（reject）', () => {
    ctx.commands.createTask({ taskId: 't1', taskType: 'normal', goal: 'x', acceptanceCriteria: 'x', workspaceId: 'ws-1', priority: 0, createdBy: 'human:u1' });
    ctx.commands.assign('module:task-service', 't1', 'agent:res-01');
    ctx.commands.submitMaterial('agent:res-01', 't1', 'n1', '材料', true);
    const ack = ctx.commands.reject('human:u1', 't1', 'n1', '驳回理由');
    expect(ack.seq).toBe(4);
  });

  it('reportIssue 产 issueReported 事件', () => {
    ctx.commands.createTask({ taskId: 't1', taskType: 'normal', goal: 'x', acceptanceCriteria: 'x', workspaceId: 'ws-1', priority: 0, createdBy: 'human:u1' });
    const ack = ctx.commands.reportIssue('agent:res-01', 't1', '问题描述');
    expect(ack.seq).toBe(2);
  });

  it('requestPathChange 产 pathChangeRequested 事件', () => {
    ctx.commands.createTask({ taskId: 't1', taskType: 'normal', goal: 'x', acceptanceCriteria: 'x', workspaceId: 'ws-1', priority: 0, createdBy: 'human:u1' });
    const ack = ctx.commands.requestPathChange('agent:res-01', 't1', '变更申请理由');
    expect(ack.seq).toBe(2);
  });

  it('restructureDAG 产 restructured 事件', () => {
    ctx.commands.createTask({ taskId: 't1', taskType: 'normal', goal: 'x', acceptanceCriteria: 'x', workspaceId: 'ws-1', priority: 0, createdBy: 'human:u1' });
    const ack = ctx.commands.restructureDAG('human:u1', 't1', 2, [{ nodeId: 'n2', goal: '新节点' }], []);
    expect(ack.seq).toBe(2);
  });

  it('publishChildTask 产 childPublished 事件', () => {
    ctx.commands.createTask({ taskId: 'agg-1', taskType: 'aggregate', goal: '聚合', acceptanceCriteria: 'x', workspaceId: 'ws-1', priority: 0, createdBy: 'human:u1' });
    const ack = ctx.commands.publishChildTask('human:u1', 'agg-1', 'child-1', 'normal', '子任务', 'x', 'ws-1', 0);
    expect(ack.seq).toBe(2);
  });
});
