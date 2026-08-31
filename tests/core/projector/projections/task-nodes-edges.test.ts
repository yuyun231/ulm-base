import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskNodesProjection } from '../../../src/core/projector/projections/task-nodes.js';
import { ProjectionsStore } from '../../../src/core/projector/projections-store.js';
import { EventStore } from '../../../src/core/event-bus/store.js';
import { EventBus } from '../../../src/core/event-bus/bus.js';
import { ProjectionRunner } from '../../../src/core/projector/runner.js';

describe('F7 DAG 边表 + 重构补完', () => {
  let projStore: ProjectionsStore;
  let eventStore: EventStore;
  let bus: EventBus;
  let runner: ProjectionRunner;

  beforeEach(() => {
    projStore = new ProjectionsStore(':memory:');
    eventStore = new EventStore(':memory:');
    bus = new EventBus(eventStore);
    runner = new ProjectionRunner(bus, eventStore, projStore, [new TaskNodesProjection()]);
    runner.start();
  });

  afterEach(() => {
    runner.stop();
    projStore.close();
    eventStore.close();
  });

  it('created 事件带 edges 时写入 task_edges 表', () => {
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'user-1' },
      family: 'task', subtype: 'created',
      handles: { taskId: 'task-1' },
      payload: {
        taskType: 'fixed', goal: '测试', acceptanceCriteria: '通过',
        dagNodes: [{ nodeId: 'n1', goal: '步骤1' }, { nodeId: 'n2', goal: '步骤2' }],
        dagEdges: [{ from: 'n1', to: 'n2' }],
      },
      value: null,
    });

    const edges = projStore.all('SELECT * FROM task_edges WHERE taskId = ? AND dagVersion = 1', 'task-1') as any[];
    expect(edges).toHaveLength(1);
    expect(edges[0].fromNode).toBe('n1');
    expect(edges[0].toNode).toBe('n2');
  });

  it('restructured 事件处理边的增删', () => {
    // 创建初始 DAG
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'user-1' },
      family: 'task', subtype: 'created',
      handles: { taskId: 'task-1' },
      payload: {
        taskType: 'aggregate', goal: '聚合', acceptanceCriteria: '完成',
        dagNodes: [{ nodeId: 'n1', goal: 'A' }, { nodeId: 'n2', goal: 'B' }],
        dagEdges: [{ from: 'n1', to: 'n2' }],
      },
      value: null,
    });
    // 重构：加节点 n3，加边 n2→n3，删边 n1→n2
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId: 'task-admin' },
      family: 'task', subtype: 'restructured',
      handles: { taskId: 'task-1' },
      payload: {
        newVersion: 2,
        addNodes: [{ nodeId: 'n3', goal: 'C' }],
        removeNodes: [],
        addEdges: [{ from: 'n2', to: 'n3' }],
        removeEdges: [{ from: 'n1', to: 'n2' }],
      },
      value: null,
    });

    // v2 的边：n1→n2 被删，n2→n3 被加
    const v2Edges = projStore.all('SELECT * FROM task_edges WHERE taskId = ? AND dagVersion = 2', 'task-1') as any[];
    expect(v2Edges).toHaveLength(1);
    expect(v2Edges[0].fromNode).toBe('n2');
    expect(v2Edges[0].toNode).toBe('n3');
  });

  it('主枝查询只返回最高 dagVersion 的节点', () => {
    // 创建 v1
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'human', userId: 'user-1' },
      family: 'task', subtype: 'created',
      handles: { taskId: 'task-1' },
      payload: { taskType: 'aggregate', goal: 'A', acceptanceCriteria: 'C',
        dagNodes: [{ nodeId: 'n1', goal: 'x' }] },
      value: null,
    });
    // 重构到 v2
    bus.publish({
      seq: null, timestamp: Date.now(),
      subject: { kind: 'agent', agentId: 'task-admin' },
      family: 'task', subtype: 'restructured',
      handles: { taskId: 'task-1' },
      payload: { newVersion: 2, addNodes: [{ nodeId: 'n2', goal: 'y' }], removeNodes: [] },
      value: null,
    });

    // 查主枝（v2）
    const mainBranch = projStore.all(
      'SELECT * FROM task_nodes WHERE taskId = ? AND dagVersion = (SELECT MAX(dagVersion) FROM task_nodes WHERE taskId = ?)',
      'task-1', 'task-1'
    ) as any[];
    expect(mainBranch).toHaveLength(2); // n1 + n2
    expect(mainBranch.some((n: any) => n.nodeId === 'n2')).toBe(true);
  });
});
